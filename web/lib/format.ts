export function formatCurrency(value: number, currency: string | null): string {
  const code = currency && /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  const fractionDigits = Math.abs(value) >= 1000 || value === 0 ? 0 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/** For chart axes, where "$140K" fits but "$140,000" gets clipped. */
export function formatCompactCurrency(value: number, currency: string | null): string {
  const code = currency && /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

/**
 * Unit costs stay at two decimals even above 1000, unlike totals.
 *
 * Sub-cent costs get four, because cost per view lives there: two decimals render every platform's
 * CPV as "$0.01" and turn a real 83% gap into two identical-looking figures.
 */
export function formatUnitCost(value: number, currency: string | null): string {
  const code = currency && /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  const decimals = value > 0 && value < 0.1 ? 4 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  }).format(value);
}

export function formatPercent(value: number, digits = 2): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export type Delta = { label: string; tone: "positive" | "negative" | "neutral" };

/**
 * Period-over-period change. `lowerIsBetter` flips the colour for cost metrics, where a
 * falling CPM is good news.
 */
export function formatDelta(
  current: number,
  previous: number,
  lowerIsBetter = false,
): Delta {
  if (previous === 0) {
    if (current === 0) return { label: "No change", tone: "neutral" };
    return { label: "New", tone: lowerIsBetter ? "neutral" : "positive" };
  }

  const change = (current - previous) / Math.abs(previous);
  if (Math.abs(change) < 0.005) return { label: "Flat", tone: "neutral" };

  const rising = change > 0;
  const good = lowerIsBetter ? !rising : rising;
  return {
    label: `${rising ? "+" : ""}${(change * 100).toFixed(change >= 10 ? 0 : 1)}%`,
    tone: good ? "positive" : "negative",
  };
}

/** "2026-09-14" -> "Sep 14", parsed as a plain date to avoid a timezone shift. */
export function formatDayLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** Turns "America/Los_Angeles" into "Los Angeles" for a card subtitle. */
export function formatTimezone(timezone: string): string {
  const city = timezone.split("/").pop() ?? timezone;
  return city.replace(/_/g, " ");
}

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
