/**
 * DAY stats have to start and end at midnight in the ad account's own timezone. The offset in
 * effect today is not that midnight once a daylight-saving change sits inside the range:
 * `2026-10-28T00:00:00-05:00` is 1am in New York on a day that was still UTC−4, and the API
 * rejects the window. Timestamps built here use the offset at local midnight on that date.
 * Campaign stats send the date alone and let the API apply this; funding-instrument stats
 * reject a bare date, so they send the timestamp.
 */

/** The synchronous stats endpoint rejects any span longer than this. */
export const MAX_SYNC_RANGE_DAYS = 7;

/** Active-entity requests are rejected once the clock span exceeds 90 days. */
export const MAX_ACTIVE_ENTITY_HOURS = 90 * 24;

/**
 * Billing settles within about 3 days but can be revised for up to 14. Days inside this
 * window are labelled provisional so a rep does not quote a figure that later moves.
 */
export const PROVISIONAL_SPEND_DAYS = 3;

function offsetAt(instant: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    }).formatToParts(instant);
    const label = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
    const match = /GMT([+-]\d{2}:\d{2})/.exec(label);
    if (match?.[1]) return match[1];
    // Intl reports plain "GMT" for UTC itself.
    if (label === "GMT") return "+00:00";
  } catch {
    // Unknown timezone string; fall through to UTC.
  }
  return "+00:00";
}

function currentUtcOffset(timeZone: string): string {
  return offsetAt(new Date(), timeZone);
}

/**
 * Offset in effect at local midnight on `date`.
 *
 * Noon is the wrong probe. On the morning the clocks fall back, noon is already standard time
 * while midnight is still daylight time, so reading "now" or reading noon stamps that midnight
 * an hour off. Start from noon, then re-read the offset at the midnight that guess implies.
 */
function offsetAtLocalMidnight(date: string, timeZone: string): string {
  let offset = offsetAt(new Date(`${date}T12:00:00Z`), timeZone);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const refined = offsetAt(new Date(`${date}T00:00:00${offset}`), timeZone);
    if (refined === offset) return offset;
    offset = refined;
  }
  return offset;
}

/** Today's calendar date in the account's timezone, as YYYY-MM-DD. */
function todayLocal(timeZone: string): string {
  const now = new Date();
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    // Unknown timezone string; fall through to UTC.
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Shifts a YYYY-MM-DD date by whole calendar days.
 *
 * Anchored at UTC midnight deliberately. UTC has no daylight saving, so adding 86,400,000ms always
 * lands on the next calendar date — which is not true of a local instant.
 */
function shiftDate(date: string, deltaDays: number): string {
  const shifted = new Date(Date.parse(`${date}T00:00:00Z`) + deltaDays * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Calendar date in the account's timezone, `daysAgo` days back, as YYYY-MM-DD.
 *
 * Today's date is resolved in the account's timezone and then walked back by calendar arithmetic,
 * rather than subtracting `daysAgo * 24h` from the current instant and formatting that. The
 * subtraction approach is wrong across a daylight-saving transition, where a local day is 23 or 25
 * hours: two different `daysAgo` values then format to the same date, the duplicate collapses in
 * the column lookup, and a real day is never requested at all. Every window still passes the
 * 7-day check, so nothing fails and nothing warns — the total is simply short by a day. Sweeping a
 * year of load times found 138 such cases per US timezone across the 7/14/30/90-day ranges.
 */
export function localDate(daysAgo: number, timeZone: string): string {
  return shiftDate(todayLocal(timeZone), -daysAgo);
}

export type StatsWindow = {
  startTime: string;
  endTime: string;
  /** The account-local dates this window covers, oldest first. */
  dates: string[];
};

export type DateRange = {
  /** Account-local dates, oldest first. One entry per column in every series. */
  dates: string[];
  /** Sub-ranges each within the synchronous 7-day limit. */
  windows: StatsWindow[];
  timeZone: string;
};

function midnight(date: string, offset: string): string {
  return `${date}T00:00:00${offset}`;
}

/** Dates for `days` complete days ending yesterday, oldest first. */
function recentDates(days: number, timeZone: string): string[] {
  const dates: string[] = [];
  for (let daysAgo = days; daysAgo >= 1; daysAgo -= 1) {
    dates.push(localDate(daysAgo, timeZone));
  }
  return dates;
}

/**
 * Splits a range into synchronous-friendly windows.
 *
 * Ranges beyond 7 days would otherwise need the asynchronous jobs endpoint, with polling and
 * a gzipped artifact to download. Chunking the synchronous endpoint instead returns identical
 * unsegmented data for a handful of extra calls, so a 30-day view costs 5 requests per batch
 * of campaigns and no job orchestration.
 */
function toWindows(dates: string[], timeZone: string): StatsWindow[] {
  const windows: StatsWindow[] = [];

  for (let index = 0; index < dates.length; index += MAX_SYNC_RANGE_DAYS) {
    windows.push(...windowFor(dates.slice(index, index + MAX_SYNC_RANGE_DAYS), timeZone));
  }

  return windows;
}

/**
 * One synchronous window, split when a daylight-saving change makes seven calendar days last
 * 169 hours. The endpoint's cap is seven days, and a range an hour over it is rejected whole.
 */
function windowFor(slice: string[], timeZone: string): StatsWindow[] {
  const first = slice[0]!;
  const last = slice[slice.length - 1]!;

  /**
   * The window is bounded by the first and last dates, so a gap in between would ask for a span
   * longer than the slice and the API would reject the whole window. Callers build contiguous
   * ranges, so this firing means a date list was constructed wrongly — worth failing loudly,
   * because the alternative is a silently short total.
   */
  if (dayDiff(first, last) + 1 !== slice.length) {
    throw new Error(
      `Reporting range is not contiguous: ${first}..${last} covers ${dayDiff(first, last) + 1} ` +
        `days but holds ${slice.length} dates.`,
    );
  }

  // end_time is exclusive, so it must be midnight of the day after the last one wanted.
  const endDate = shiftDate(last, 1);
  const startTime = midnight(first, offsetAtLocalMidnight(first, timeZone));
  const endTime = midnight(endDate, offsetAtLocalMidnight(endDate, timeZone));
  const hours = (Date.parse(endTime) - Date.parse(startTime)) / 3_600_000;

  if (hours > MAX_SYNC_RANGE_DAYS * 24 && slice.length > 1) {
    const mid = Math.floor(slice.length / 2);
    return [
      ...windowFor(slice.slice(0, mid), timeZone),
      ...windowFor(slice.slice(mid), timeZone),
    ];
  }

  return [{ startTime, endTime, dates: slice }];
}

/**
 * Groups windows so each span stays inside `maxHours` of clock time.
 *
 * Ninety calendar days that include the autumn clock change last ninety days and one hour.
 * Active entities reject that as over the 90-day cap, which would drop the list of campaigns
 * that actually spent. Sync windows are already at most seven days, so the split always lands
 * on a boundary between them.
 */
export function spansWithin(
  windows: StatsWindow[],
  maxHours: number,
): Array<{ startTime: string; endTime: string }> {
  const spans: Array<{ startTime: string; endTime: string }> = [];
  let groupStart: StatsWindow | null = null;
  let groupEnd: StatsWindow | null = null;

  for (const window of windows) {
    if (!groupStart || !groupEnd) {
      groupStart = window;
      groupEnd = window;
      continue;
    }
    const hours = (Date.parse(window.endTime) - Date.parse(groupStart.startTime)) / 3_600_000;
    if (hours > maxHours) {
      spans.push({ startTime: groupStart.startTime, endTime: groupEnd.endTime });
      groupStart = window;
      groupEnd = window;
      continue;
    }
    groupEnd = window;
  }

  if (groupStart && groupEnd) {
    spans.push({ startTime: groupStart.startTime, endTime: groupEnd.endTime });
  }
  return spans;
}

export function buildRange(days: number, timeZone: string): DateRange {
  const dates = recentDates(days, timeZone);
  return { dates, windows: toWindows(dates, timeZone), timeZone };
}

/** The equally sized range immediately before `days`, for period-over-period deltas. */
export function buildPreviousRange(days: number, timeZone: string): DateRange {
  const dates: string[] = [];
  for (let daysAgo = days * 2; daysAgo >= days + 1; daysAgo -= 1) {
    dates.push(localDate(daysAgo, timeZone));
  }
  return { dates, windows: toWindows(dates, timeZone), timeZone };
}

/** Whole days from `from` to `to`, both YYYY-MM-DD. Negative when `to` precedes `from`. */
export function dayDiff(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

/** Every date from `from` to `to` inclusive, oldest first. */
export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  const span = dayDiff(from, to);
  for (let offset = 0; offset <= span; offset += 1) {
    const day = new Date(Date.parse(`${from}T00:00:00Z`) + offset * 86_400_000);
    dates.push(day.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * A range over an arbitrary span of account-local dates, for spans that do not end yesterday
 * or line up with the dashboard's 7/14/30/90 choices — flight-to-date spend being the case.
 */
export function buildRangeBetween(from: string, to: string, timeZone: string): DateRange {
  const dates = datesBetween(from, to);
  return { dates, windows: toWindows(dates, timeZone), timeZone };
}

/** Kept for the account picker sparkline, which only ever needs one 7-day window. */
export function recentDayRange(days: number, timeZone: string) {
  const offset = currentUtcOffset(timeZone);
  return {
    startTime: midnight(localDate(days, timeZone), offset),
    endTime: midnight(localDate(0, timeZone), offset),
    days,
  };
}

/** How many trailing dates in `dates` fall inside the billing revision window. */
export function provisionalDayCount(dates: string[], timeZone: string): number {
  const cutoff = localDate(PROVISIONAL_SPEND_DAYS, timeZone);
  return dates.filter((date) => date >= cutoff).length;
}

export function microsToCurrency(micros: number | null | undefined): number {
  if (!micros) return 0;
  return micros / 1_000_000;
}
