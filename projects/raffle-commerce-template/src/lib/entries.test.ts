import { describe, expect, it } from "vitest";
import { calculateEntries, sumEntries } from "./entries";

describe("calculateEntries", () => {
  it("uses whole qualifying currency units after discounts and excludes fractional units", () => {
    const result = calculateEntries({
      unitPriceCents: 2599,
      quantity: 2,
      discountCents: 199,
      baseEntriesPerDollar: 1,
      productMultiplier: 2,
      campaignMultiplier: 250,
    });
    expect(result.qualifyingCents).toBe(4999);
    expect(result.qualifyingWholeDollars).toBe(49);
    expect(result.finalEntries).toBe(24_500n);
    expect(result.snapshot.finalEntries).toBe("24500");
  });

  it("applies an entrant cap without floating point arithmetic", () => {
    const result = calculateEntries({
      unitPriceCents: 49_900,
      quantity: 4,
      baseEntriesPerDollar: 1,
      productMultiplier: 2,
      campaignMultiplier: 500,
      cap: 1_000_000n,
    });
    expect(result.finalEntries).toBe(1_000_000n);
    expect(result.snapshot.capped).toBe(true);
  });

  it("rejects invalid quantities and multipliers", () => {
    expect(() => calculateEntries({
      unitPriceCents: 1000,
      quantity: 0,
      baseEntriesPerDollar: 1,
    })).toThrow(/quantity/);
  });

  it("sums bigint entry values", () => {
    expect(sumEntries([1n, 2n, 5_000_000_000n])).toBe(5_000_000_003n);
  });
});
