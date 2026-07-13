export type CampaignMultiplierSlot = {
  id: string;
  label: string;
  numerator: number;
  denominator: number;
  startsAt: Date;
  endsAt: Date;
};

export type ResolvedCampaignMultiplier = {
  factor: number;
  snapshot:
    | { source: "CAMPAIGN_CURRENT"; factor: number }
    | {
        source: "SCHEDULED_PERIOD";
        factor: number;
        slotId: string;
        label: string;
        numerator: number;
        denominator: number;
        startsAt: string;
        endsAt: string;
      };
};

function positiveInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
}

export function resolveConfiguredCampaignMultiplier(input: {
  currentMultiplier: number;
  slots: CampaignMultiplierSlot[];
  at: Date;
}): ResolvedCampaignMultiplier {
  positiveInteger(input.currentMultiplier, "Campaign current multiplier");
  if (input.slots.length === 0) {
    return {
      factor: input.currentMultiplier,
      snapshot: { source: "CAMPAIGN_CURRENT", factor: input.currentMultiplier },
    };
  }
  const active = input.slots.filter((slot) => slot.startsAt <= input.at && input.at < slot.endsAt);
  if (active.length !== 1) {
    throw new Error(active.length === 0
      ? "Campaign has multiplier periods configured but none is active"
      : "Campaign has overlapping active multiplier periods");
  }
  const slot = active[0]!;
  positiveInteger(slot.numerator, "Multiplier numerator");
  positiveInteger(slot.denominator, "Multiplier denominator");
  if (slot.numerator % slot.denominator !== 0) {
    throw new Error("Active multiplier period does not resolve to an integral factor");
  }
  const factor = slot.numerator / slot.denominator;
  positiveInteger(factor, "Resolved campaign multiplier");
  return {
    factor,
    snapshot: {
      source: "SCHEDULED_PERIOD",
      factor,
      slotId: slot.id,
      label: slot.label,
      numerator: slot.numerator,
      denominator: slot.denominator,
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt.toISOString(),
    },
  };
}
