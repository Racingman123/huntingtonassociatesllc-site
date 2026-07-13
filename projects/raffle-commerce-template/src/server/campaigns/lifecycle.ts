const transitions: Record<string, readonly string[]> = {
  DRAFT: ["IN_REVIEW", "CANCELLED"],
  IN_REVIEW: ["DRAFT", "APPROVED", "CANCELLED"],
  APPROVED: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["LIVE", "SUSPENDED", "CANCELLED"],
  LIVE: ["ENTRY_CLOSED", "SUSPENDED", "CANCELLED"],
  SUSPENDED: ["LIVE", "CANCELLED"],
  ENTRY_CLOSED: ["RECONCILING", "SNAPSHOT_REVIEW"],
  RECONCILING: ["SNAPSHOT_REVIEW"],
  SNAPSHOT_REVIEW: ["RECONCILING", "SEALED"],
  SEALED: ["RECONCILING", "WINNER_PENDING"],
  WINNER_PENDING: ["COMPLETED"],
  COMPLETED: ["ARCHIVED"],
  CANCELLED: ["ARCHIVED"],
  ARCHIVED: [],
};

export function canTransitionCampaign(from: string, to: string) {
  return transitions[from]?.includes(to) ?? false;
}

export function assertCampaignTransition(from: string, to: string) {
  if (!canTransitionCampaign(from, to)) throw new Error(`Campaign cannot transition from ${from} to ${to}`);
}

export const campaignLifecycle = transitions;
