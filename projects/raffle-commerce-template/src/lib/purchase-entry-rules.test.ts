import { describe, expect, it } from "vitest";
import { calculateStorefrontEntryQuote, createStorefrontEntryQuote, resolvePurchaseEntryRules } from "./purchase-entry-rules";

const at = new Date("2027-06-10T12:00:00.000Z");
const target = {
  productId: "product-id",
  productSlug: "trail-kit",
  category: "Gear",
  collectionIds: ["collection-id"],
  collectionSlugs: ["new-releases"],
  variantId: "variant-id",
  variantSku: "TRAIL-BLACK",
};

function rule(overrides: Partial<Parameters<typeof resolvePurchaseEntryRules>[0]["rules"][number]> = {}) {
  return {
    id: "all-v1",
    name: "All products",
    ruleType: "MONEY_RATE",
    targetType: "ALL",
    targetId: null,
    entriesPerDollar: 1,
    multiplierNumerator: 1,
    multiplierDenominator: 1,
    stackPriority: 0,
    startsAt: null,
    endsAt: null,
    version: 1,
    active: true,
    ...overrides,
  };
}

describe("purchase entry rules", () => {
  it("combines campaign base, catalog, campaign, and distinct targeted priorities exactly once", () => {
    const quote = createStorefrontEntryQuote({
      unitPriceCents: 5_550,
      at,
      campaignBaseEntriesPerCurrencyUnit: 3,
      catalogProductMultiplier: 2,
      campaignMultiplier: 10,
      target,
      rules: [
        rule(),
        rule({ id: "category", name: "Gear boost", targetType: "CATEGORY", targetId: "Gear", multiplierNumerator: 2, stackPriority: 10 }),
        rule({ id: "product", name: "Kit boost", targetType: "PRODUCT", targetId: "trail-kit", multiplierNumerator: 3, stackPriority: 20 }),
        rule({ id: "variant", name: "Black boost", targetType: "VARIANT", targetId: "TRAIL-BLACK", multiplierNumerator: 2, stackPriority: 30 }),
      ],
    });
    expect(quote.purchaseRuleMultiplier).toBe(12);
    expect(quote.effectiveMultiplier).toBe(240);
    expect(calculateStorefrontEntryQuote(quote, 1).finalEntries).toBe(39_600n);
    expect(quote.ruleSnapshot.matchedRules.map((item) => item.id)).toEqual(["all-v1", "category", "product", "variant"]);
  });

  it("matches collection ids or slugs and ignores future rules", () => {
    const resolved = resolvePurchaseEntryRules({
      at,
      campaignBaseEntriesPerCurrencyUnit: 1,
      catalogProductMultiplier: 1,
      campaignMultiplier: 1,
      target,
      rules: [
        rule(),
        rule({ id: "collection", name: "Collection", targetType: "COLLECTION", targetId: "new-releases", multiplierNumerator: 4, stackPriority: 10 }),
        rule({ id: "future", name: "Future", targetType: "PRODUCT", targetId: "product-id", multiplierNumerator: 99, stackPriority: 20, startsAt: "2027-07-01T00:00:00.000Z" }),
      ],
    });
    expect(resolved.purchaseRuleMultiplier).toBe(4);
  });

  it("fails closed when matching rules share a priority", () => {
    expect(() => resolvePurchaseEntryRules({
      at,
      campaignBaseEntriesPerCurrencyUnit: 1,
      catalogProductMultiplier: 1,
      campaignMultiplier: 1,
      target,
      rules: [
        rule(),
        rule({ id: "also-zero", name: "Collision", targetType: "PRODUCT", targetId: "product-id" }),
      ],
    })).toThrow(/Ambiguous purchase-entry rules/);
  });

  it("fails closed for a fractional rule multiplier or uncovered product", () => {
    expect(() => resolvePurchaseEntryRules({
      at,
      campaignBaseEntriesPerCurrencyUnit: 1,
      catalogProductMultiplier: 1,
      campaignMultiplier: 1,
      target,
      rules: [rule({ multiplierNumerator: 3, multiplierDenominator: 2 })],
    })).toThrow(/integral/);
    expect(() => resolvePurchaseEntryRules({
      at,
      campaignBaseEntriesPerCurrencyUnit: 1,
      catalogProductMultiplier: 1,
      campaignMultiplier: 1,
      target,
      rules: [rule({ targetType: "CATEGORY", targetId: "Apparel" })],
    })).toThrow(/No active purchase-entry rule/);
  });
});
