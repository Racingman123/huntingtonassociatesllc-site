import { describe, expect, it } from "vitest";
import {
  calculatePeriodEnd,
  calculateRenewal,
  selectMembershipEntryBand,
  type MembershipBand,
} from "./calculation";

const bands = [
  {
    id: "starter",
    minimumSettledCycles: 0,
    maximumSettledCycles: 2,
    fixedEntries: 6_250n,
    multiplierNumerator: 1,
    multiplierDenominator: 1,
  },
  {
    id: "loyal",
    minimumSettledCycles: 3,
    maximumSettledCycles: 5,
    fixedEntries: 7_500n,
    multiplierNumerator: 1,
    multiplierDenominator: 1,
  },
  {
    id: "veteran",
    minimumSettledCycles: 6,
    maximumSettledCycles: null,
    fixedEntries: 10_000n,
    multiplierNumerator: 1,
    multiplierDenominator: 1,
  },
] satisfies MembershipBand[];

describe("selectMembershipEntryBand", () => {
  it("uses prior settled-cycle tenure at inclusive range boundaries", () => {
    expect(selectMembershipEntryBand(bands, 0).id).toBe("starter");
    expect(selectMembershipEntryBand(bands, 2).id).toBe("starter");
    expect(selectMembershipEntryBand(bands, 3).id).toBe("loyal");
    expect(selectMembershipEntryBand(bands, 5).id).toBe("loyal");
    expect(selectMembershipEntryBand(bands, 6).id).toBe("veteran");
    expect(selectMembershipEntryBand(bands, 50).id).toBe("veteran");
  });

  it("fails closed for gaps and overlapping campaign configuration", () => {
    expect(() => selectMembershipEntryBand(bands.slice(1), 0)).toThrow(/No membership entry band/);
    expect(() => selectMembershipEntryBand([
      bands[0],
      { ...bands[1], minimumSettledCycles: 2 },
    ], 2)).toThrow(/overlap/);
  });
});

describe("calculateRenewal", () => {
  it("quotes the authoritative plan price, next period, tenure award, and cap", () => {
    const result = calculateRenewal({
      priceCents: 2_500,
      currency: "USD",
      interval: "MONTH",
      intervalCount: 1,
      settledCycleCount: 3,
      currentPeriodStartsAt: new Date("2027-12-31T15:45:00.000Z"),
      currentPeriodEndsAt: new Date("2028-01-31T15:45:00.000Z"),
      bands,
      remainingEntryCapacity: 7_000n,
    });

    expect(result.cycleNumber).toBe(4);
    expect(result.priceCents).toBe(2_500);
    expect(result.periodStartsAt.toISOString()).toBe("2028-01-31T15:45:00.000Z");
    expect(result.periodEndsAt.toISOString()).toBe("2028-02-29T15:45:00.000Z");
    expect(result.band.id).toBe("loyal");
    expect(result.uncappedEntries).toBe(7_500n);
    expect(result.awardedEntries).toBe(7_000n);
    expect(result.capApplied).toBe(true);
    expect(result.snapshot.awardedEntries).toBe("7000");
  });

  it("uses integer rational arithmetic and explicitly floors fractional entries", () => {
    const result = calculateRenewal({
      priceCents: 999,
      currency: "USD",
      interval: "WEEK",
      intervalCount: 2,
      settledCycleCount: 0,
      currentPeriodStartsAt: new Date("2026-07-12T12:00:00.000Z"),
      currentPeriodEndsAt: new Date("2026-07-26T12:00:00.000Z"),
      bands: [{
        id: "fractional-multiplier",
        minimumSettledCycles: 0,
        maximumSettledCycles: null,
        fixedEntries: 5n,
        multiplierNumerator: 3,
        multiplierDenominator: 2,
      }],
      campaignMultiplier: 3,
    });

    expect(result.periodStartsAt.toISOString()).toBe("2026-07-12T12:00:00.000Z");
    expect(result.periodEndsAt.toISOString()).toBe("2026-07-26T12:00:00.000Z");
    expect(result.uncappedEntries).toBe(22n);
    expect(result.awardedEntries).toBe(22n);
    expect(result.snapshot.campaignMultiplier).toBe(3);
    expect(result.snapshot.rounding).toBe("FLOOR_TO_WHOLE_ENTRY");
  });

  it("clamps leap-day annual billing to the last day of February", () => {
    expect(calculatePeriodEnd(
      new Date("2028-02-29T08:30:00.000Z"),
      "YEAR",
      1,
    ).toISOString()).toBe("2029-02-28T08:30:00.000Z");
  });
});
