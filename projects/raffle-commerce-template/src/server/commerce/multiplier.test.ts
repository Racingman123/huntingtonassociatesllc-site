import { describe, expect, it } from "vitest";
import { resolveConfiguredCampaignMultiplier } from "./multiplier";

const at = new Date("2026-07-12T12:00:00.000Z");

function slot(overrides: Partial<{
  id: string;
  label: string;
  numerator: number;
  denominator: number;
  startsAt: Date;
  endsAt: Date;
}> = {}) {
  return {
    id: "slot-1",
    label: "Active 250X",
    numerator: 250,
    denominator: 1,
    startsAt: new Date("2026-07-12T00:00:00.000Z"),
    endsAt: new Date("2026-07-13T00:00:00.000Z"),
    ...overrides,
  };
}

describe("campaign checkout multiplier resolution", () => {
  it("falls back only when no schedule is configured", () => {
    expect(resolveConfiguredCampaignMultiplier({ currentMultiplier: 10, slots: [], at }))
      .toEqual({ factor: 10, snapshot: { source: "CAMPAIGN_CURRENT", factor: 10 } });
  });

  it("resolves and snapshots exactly one active integral scheduled factor", () => {
    expect(resolveConfiguredCampaignMultiplier({ currentMultiplier: 10, slots: [slot()], at }))
      .toMatchObject({
        factor: 250,
        snapshot: {
          source: "SCHEDULED_PERIOD",
          slotId: "slot-1",
          numerator: 250,
          denominator: 1,
        },
      });
  });

  it("rejects schedule gaps, overlaps, and fractional factors", () => {
    expect(() => resolveConfiguredCampaignMultiplier({
      currentMultiplier: 10,
      slots: [slot({ startsAt: new Date("2026-07-13T00:00:00.000Z") })],
      at,
    })).toThrow(/none is active/);
    expect(() => resolveConfiguredCampaignMultiplier({
      currentMultiplier: 10,
      slots: [slot(), slot({ id: "slot-2" })],
      at,
    })).toThrow(/overlapping/);
    expect(() => resolveConfiguredCampaignMultiplier({
      currentMultiplier: 10,
      slots: [slot({ numerator: 5, denominator: 2 })],
      at,
    })).toThrow(/integral/);
  });
});
