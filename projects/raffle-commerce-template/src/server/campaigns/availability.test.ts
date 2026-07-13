import { describe, expect, it } from "vitest";
import { campaignAvailability } from "./availability";

const now = new Date("2026-07-11T12:00:00.000Z");

function campaign(overrides: Partial<{
  status: string;
  startsAt: Date;
  endsAt: Date;
  freeEntryEndsAt: Date;
}> = {}) {
  return {
    status: "LIVE",
    startsAt: new Date("2026-07-01T00:00:00.000Z"),
    endsAt: new Date("2026-07-10T00:00:00.000Z"),
    freeEntryEndsAt: new Date("2026-07-12T00:00:00.000Z"),
    ...overrides,
  };
}

describe("campaign storefront availability", () => {
  it("distinguishes the optional post-purchase AMOE window", () => {
    expect(campaignAvailability(campaign(), now)).toEqual({
      purchaseEntryOpen: false,
      freeEntryOpen: true,
      publicState: "FREE_ENTRY_ONLY",
    });
  });

  it("keeps free entry available after maintenance marks purchase entry closed", () => {
    expect(campaignAvailability(campaign({ status: "ENTRY_CLOSED" }), now).freeEntryOpen).toBe(true);
  });

  it("fails closed for sealed and future campaigns", () => {
    expect(campaignAvailability(campaign({ status: "SEALED" }), now).publicState).toBe("CLOSED");
    expect(campaignAvailability(campaign({ startsAt: new Date("2026-07-20T00:00:00.000Z") }), now).publicState)
      .toBe("UPCOMING");
  });
});
