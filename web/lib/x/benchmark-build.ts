import { buildBenchmark, SMALL_COHORT, type Benchmark } from "./benchmark";
import { fetchExtendedHistory } from "./benchmark-history";
import type { MetricSeries } from "./stats";
import { readCampaignLabels } from "../store";
import type { CampaignLabelKind, XCredentials } from "../store";
import type { CampaignRow, DashboardPayload } from "@/app/accounts/[accountId]/types";
import type { Actor } from "../auth/actor";

/**
 * Builds the benchmark, reaching past the window only when the window cannot carry the comparison.
 *
 * Shared by the panel's endpoint and the AI summary's because they must agree. When they each did
 * their own assembly, only the panel attempted the longer lookback — so a campaign whose only
 * history was older than 90 days showed a full comparison on screen and the summary beside it
 * refused to discuss it, which reads as the tool contradicting itself.
 */
export async function buildBenchmarkWithLookback(options: {
  credentials: XCredentials;
  accountId: string;
  asUser: string | null;
  actor: Actor;
  dashboard: DashboardPayload & { rawSeries?: Record<string, MetricSeries> };
  campaign: CampaignRow;
  windowDays: number;
}): Promise<Benchmark> {
  const { credentials, accountId, asUser, actor, dashboard, campaign, windowDays } = options;
  const rawSeries = dashboard.rawSeries ?? {};

  /**
   * Read here rather than taken from the rows' pacing verdicts, because the lookback's campaigns
   * never get one and they have to be filtered by the same rule. A failure is not fatal: the
   * comparison falls back to every campaign on the objective, which is what it was before labels
   * existed, so a database blip costs precision rather than the panel.
   */
  const labels = await readCampaignLabels(accountId).catch(
    () => new Map<string, CampaignLabelKind>(),
  );

  const recent = buildBenchmark({
    campaign,
    history: dashboard.campaigns,
    rawSeries,
    windowDays,
    labels,
  });

  /**
   * Reaching further back is attempted only when the recent window cannot carry the comparison.
   * Doing it always would be both slower and worse: a cohort that already has enough concurrent
   * campaigns is the best baseline available, and diluting it with campaigns from last autumn would
   * trade a like-for-like read for a longer one.
   */
  const thin =
    recent.status === "no-cohort" ||
    (recent.status === "ok" && recent.cohort.campaigns < SMALL_COHORT);

  if (!thin || !campaign.objective) return recent;

  const older = await fetchExtendedHistory({
    credentials,
    accountId,
    asUser,
    actor,
    timeZone: dashboard.account.timezone,
    objective: campaign.objective,
    coveredDays: windowDays,
    /**
     * Only campaigns that delivered inside the window, because only those can already be in the
     * recent cohort. Excluding every row the dashboard lists would also drop campaigns that are
     * merely *listed* — a flight that ended eight months ago is still returned by `GET /campaigns` —
     * and those are exactly the ones the lookback exists to find.
     */
    excludeIds: new Set(
      dashboard.campaigns
        .filter((row) => row.totals.impressions > 0 || row.totals.spend > 0)
        .map((row) => row.id),
    ),
  });

  return buildBenchmark({
    campaign,
    history: dashboard.campaigns,
    rawSeries,
    windowDays,
    labels,
    older: older.campaigns,
    lookback: { fromDate: older.fromDate, toDate: older.toDate, reason: older.reason },
  });
}
