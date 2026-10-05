"use client";

import { AskGrok } from "@/components/ask-grok";
import type { CampaignRow } from "../types";

const SUGGESTIONS = [
  "Which one should we put more budget behind, and why?",
  "Write this as a short note I can send the advertiser.",
  "What would you push back on if the advertiser says this underperformed?",
];

export function SummaryPanel({
  accountId,
  asUser,
  days,
  takeovers,
  campaigns,
}: {
  accountId: string;
  asUser: string | null;
  days: number;
  takeovers: boolean;
  campaigns: CampaignRow[];
}) {
  return (
    <AskGrok
      endpoint={`/api/accounts/${accountId}/compare-summary`}
      body={{ asUser, days, takeovers, ids: campaigns.map((campaign) => campaign.id) }}
      title="Grok summary"
      description="Written from the same figures shown above. Numbers come from the API, not the model."
      primaryLabel="Summarize"
      emptyState={`Nothing generated yet. Summarize these ${campaigns.length} campaigns, or ask something specific.`}
      suggestions={SUGGESTIONS}
      askPlaceholder="Ask about these campaigns…"
      unconfiguredHint="Add your own xAI API key to get a written comparison and ask follow-up questions."
    />
  );
}
