type CampaignWindow = {
  status: string;
  startsAt: Date;
  endsAt: Date;
  freeEntryEndsAt: Date;
};

export type CampaignAvailability = {
  purchaseEntryOpen: boolean;
  freeEntryOpen: boolean;
  publicState: "UPCOMING" | "OPEN" | "FREE_ENTRY_ONLY" | "CLOSED";
};

/**
 * Display-only lifecycle derivation. Mutation services must independently
 * re-read the campaign and enforce these boundaries inside their transaction.
 */
export function campaignAvailability(
  campaign: CampaignWindow,
  now = new Date(),
): CampaignAvailability {
  const started = now >= campaign.startsAt;
  const purchaseEntryOpen = campaign.status === "LIVE"
    && started
    && now < campaign.endsAt;
  const freeEntryOpen = ["LIVE", "ENTRY_CLOSED"].includes(campaign.status)
    && started
    && now < campaign.freeEntryEndsAt;

  return {
    purchaseEntryOpen,
    freeEntryOpen,
    publicState: !started
      ? "UPCOMING"
      : purchaseEntryOpen
        ? "OPEN"
        : freeEntryOpen
          ? "FREE_ENTRY_ONLY"
          : "CLOSED",
  };
}
