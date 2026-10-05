import type { AudienceBreakdown } from "@/lib/x/audience";
import type { SegmentBreakdown } from "@/lib/x/segments";

/**
 * A single readable observation about a campaign's delivery.
 *
 * Every one is arithmetic over figures already fetched from the Ads API — no model is involved, and
 * nothing is asserted beyond the comparison in the text. That matters because these sit at the top of
 * the drawer where they read as conclusions: an insight that cannot be traced to a number in the
 * panels below it does not belong here. When the data supports nothing, this returns an empty list
 * and the section does not render, which is better than filler.
 */
export type Insight = {
  /** Short bold clause, e.g. "Audience core". */
  title: string;
  /** The supporting sentence, carrying the figures. */
  detail: string;
};

const pct = (value: number, digits = 1) => `${(value * 100).toFixed(digits)}%`;

const compact = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(2)}M`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(1)}K`
      : String(Math.round(value));

/** Below this, a gender split is a balanced book rather than a skew worth naming. */
const SKEW_FLOOR = 0.55;

/** A platform must carry this much of the spend before it is worth a sentence. */
const NOTABLE_SHARE = 0.1;

/** Click rates within this of each other are the same rate; an "edge" needs to be visible. */
const CTR_EDGE = 1.25;

export function buildInsights(input: {
  platform: SegmentBreakdown;
  audience: AudienceBreakdown;
  currency: string | null;
}): Insight[] {
  const insights: Insight[] = [];
  const { platform, audience } = input;
  const platformRows = platform.status === "ok" ? platform.rows : [];

  // Cost efficiency first: it is the only one of these that implies an action.
  if (platform.efficiency) {
    const e = platform.efficiency;
    insights.push(
      e.material
        ? {
            title: `${e.cheapest.label} buys more cheaply`,
            detail:
              `${money(e.cheapest.value, input.currency)} ${e.label} on ${e.cheapest.label} against ` +
              `${money(e.dearest.value, input.currency)} on ${e.dearest.label} — ${pct(e.gap, 0)} more ` +
              `for the same thing, on ${pct(e.dearest.spendShare, 0)} of the spend.`,
          }
        : {
            title: "Platforms priced alike",
            detail:
              `Every platform is within ${pct(e.gap, 0)} of the others on ${e.label}, so there is ` +
              `nothing to shift between them.`,
          },
    );
  }

  /**
   * Where the money went, which frames every other platform statement. A platform holding
   * essentially all of it is a different sentence: naming the runner-up at "0%" reads like a
   * comparison when it is really a rounding artefact.
   */
  const lead = platformRows[0];
  if (lead && lead.spendShare >= NOTABLE_SHARE) {
    const second = platformRows.find((row) => row !== lead && row.spendShare >= 0.01);
    insights.push(
      second
        ? {
            title: `${lead.label}-weighted book`,
            detail:
              `${pct(lead.spendShare, 0)} of delivery ran on ${lead.label}, against ` +
              `${pct(second.spendShare, 0)} on ${second.label}.`,
          }
        : {
            title: "Single-platform delivery",
            detail: `Effectively all spend ran on ${lead.label}.`,
          },
    );
  }

  /**
   * Click rates are a separate story from cost, and the interesting case is when they disagree: the
   * cheapest impressions and the most responsive audience are routinely not the same platform.
   */
  const clickable = platformRows.filter(
    (row) => row.spendShare >= NOTABLE_SHARE && row.totals.ctr > 0,
  );
  if (clickable.length >= 2) {
    const ranked = [...clickable].sort((a, b) => b.totals.ctr - a.totals.ctr);
    const best = ranked[0]!;
    const worst = ranked[ranked.length - 1]!;
    if (best.totals.ctr >= worst.totals.ctr * CTR_EDGE) {
      insights.push({
        title: `Engagement edge on ${best.label}`,
        detail:
          `${best.label} clicked through at ${pct(best.totals.ctr, 3)} against ${worst.label} at ` +
          `${pct(worst.totals.ctr, 3)}.`,
      });
    }
  }

  if (audience.status === "ok") {
    // Which band actually carried the campaign, by volume rather than by targeting intent.
    const byVolume = [...audience.age].sort((a, b) => b.impressions - a.impressions);
    const top = byVolume[0];
    if (top) {
      const second = byVolume[1];
      insights.push({
        title: "Audience core",
        detail:
          `Ages ${top.label} led volume at ${compact(top.impressions)} impressions ` +
          `(${pct(top.share, 0)} of delivery)` +
          (second
            ? `; ${second.label} followed at ${compact(second.impressions)}.`
            : "."),
      });
    }

    const male = audience.gender.find((band) => band.key === "Male");
    const female = audience.gender.find((band) => band.key === "Female");
    if (male && female) {
      const [front, back] = male.share >= female.share ? [male, female] : [female, male];
      insights.push(
        front.share >= SKEW_FLOOR
          ? {
              title: `${front.label}-skewed delivery`,
              detail:
                `${pct(front.share)} of impressions reached a ${front.label.toLowerCase()} audience ` +
                `against ${pct(back.share)} ${back.label.toLowerCase()}.`,
            }
          : {
              title: "Balanced gender mix",
              detail:
                `Delivery split ${pct(front.share)} ${front.label.toLowerCase()} to ` +
                `${pct(back.share)} ${back.label.toLowerCase()}.`,
            },
      );
    }
  }

  /**
   * Spotlight is a slice of the totals above, so it is phrased as a share and never as an addition.
   * A slice too small to round to a percent has a CPM too thin to draw a conclusion from, and
   * "0% of spend, 69% cheaper" invites a reallocation the data cannot support.
   */
  if (platform.spotlight && platform.spotlight.spendShare >= 0.01 && platform.spotlight.rest.cpm > 0) {
    const s = platform.spotlight;
    const delta = s.cpm / s.rest.cpm - 1;
    insights.push({
      title: "Spotlight slice",
      detail:
        `${pct(s.spendShare, 0)} of spend served in Spotlight at ${money(s.cpm, input.currency)} per ` +
        `thousand impressions, ${
          Math.abs(delta) < 0.05
            ? "much the same as"
            : `${pct(Math.abs(delta), 0)} ${delta > 0 ? "dearer than" : "cheaper than"}`
        } the rest of the buy.`,
    });
  }

  return insights;
}

const money = (value: number, currency: string | null) => {
  const code = currency && /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  // Cost per view lives below a cent, where two decimals renders every platform as "$0.01".
  const decimals = value > 0 && value < 0.1 ? 4 : 2;
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: code,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
};
