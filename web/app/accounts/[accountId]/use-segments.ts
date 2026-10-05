"use client";

import { useQuery } from "@tanstack/react-query";

import type { AudienceBreakdown } from "@/lib/x/audience";
import type { SegmentBreakdown } from "@/lib/x/segments";

export type SegmentResponse = {
  days: number;
  breakdown: SegmentBreakdown;
  audience: AudienceBreakdown;
};

export type SegmentsQuery = {
  accountId: string;
  campaignId: string;
  asUser: string | null;
  days: number;
  timezone: string;
};

/**
 * The segmented breakdowns for one campaign: platforms, age and gender.
 *
 * Three asynchronous jobs behind a single request, shared by the insights, platform and audience
 * panels. They all pass the same query key deliberately — TanStack then serves one fetch to all
 * three rather than starting three sets of jobs for the same campaign.
 */
export function useSegments({ accountId, campaignId, asUser, days, timezone }: SegmentsQuery) {
  return useQuery({
    queryKey: ["segments", accountId, campaignId, asUser ?? "direct", days],
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: async () => {
      const params = new URLSearchParams({ days: String(days), timezone });
      if (asUser) params.set("asUser", asUser);
      const response = await fetch(
        `/api/accounts/${accountId}/campaigns/${campaignId}/segments?${params.toString()}`,
        { cache: "no-store" },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Could not load the breakdown.");
      return payload as SegmentResponse;
    },
  });
}
