import { describe, expect, it } from "vitest";
import { analyzePurchaseEntryCatalog } from "./catalog-readiness";

const window = {
  purchaseStartsAt: "2035-06-01T04:00:00.000Z",
  purchaseEndsAt: "2035-07-02T03:59:59.000Z",
};

const products = [{
  id: "product-id",
  slug: "road-kit",
  category: "Gear",
  productType: "PHYSICAL",
  variants: [{ id: "variant-id", sku: "ROAD-KIT-01" }],
  collections: [{ collection: { id: "collection-id", slug: "new-releases" } }],
}, {
  id: "membership-id",
  slug: "monthly-club",
  category: "Membership",
  productType: "MEMBERSHIP",
  variants: [{ id: "membership-variant", sku: "MEMBERSHIP-01" }],
  collections: [],
}];

function rule(overrides: Partial<{
  name: string;
  targetType: "ALL" | "CATEGORY" | "COLLECTION" | "PRODUCT" | "VARIANT";
  targetId: string | null;
  startsAt: string | null;
  endsAt: string | null;
  active: boolean;
}> = {}) {
  return {
    name: "Standard rate",
    targetType: "ALL" as const,
    targetId: null,
    startsAt: null,
    endsAt: null,
    active: true,
    ...overrides,
  };
}

describe("campaign purchase-entry catalog readiness", () => {
  it("covers ordinary variants without requiring membership variants", () => {
    const readiness = analyzePurchaseEntryCatalog({ ...window, products, rules: [rule()] });
    expect(readiness).toMatchObject({
      ready: true,
      purchasableProductCount: 1,
      purchasableVariantCount: 1,
      productsWithoutActiveVariants: [],
      uncoveredVariants: [],
    });
  });

  it("blocks an active ordinary product with no active variant even when other products are covered", () => {
    const readiness = analyzePurchaseEntryCatalog({
      ...window,
      products: [...products, {
        id: "empty-product-id",
        slug: "empty-product",
        category: "Gear",
        productType: "DIGITAL",
        variants: [],
        collections: [],
      }],
      rules: [rule()],
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.productsWithoutActiveVariants).toEqual([{
      productId: "empty-product-id",
      productSlug: "empty-product",
    }]);
    expect(readiness.issues).toContain("Active product 'empty-product' has no active purchasable variant");
  });

  it.each([
    ["CATEGORY", "Missing category"],
    ["COLLECTION", "missing-collection"],
    ["PRODUCT", "missing-product"],
    ["VARIANT", "missing-sku"],
  ] as const)("rejects an unresolved %s target", (targetType, targetId) => {
    const readiness = analyzePurchaseEntryCatalog({
      ...window,
      products,
      rules: [rule({ targetType, targetId })],
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.targetChecks[0]).toMatchObject({ targetType, targetId, ready: false });
  });

  it.each([
    ["CATEGORY", "Gear"],
    ["COLLECTION", "collection-id"],
    ["COLLECTION", "new-releases"],
    ["PRODUCT", "product-id"],
    ["PRODUCT", "road-kit"],
    ["VARIANT", "variant-id"],
    ["VARIANT", "ROAD-KIT-01"],
  ] as const)("resolves an active %s target by its supported catalog key", (targetType, targetId) => {
    const readiness = analyzePurchaseEntryCatalog({
      ...window,
      products,
      rules: [rule({ targetType, targetId })],
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.targetChecks[0]).toMatchObject({
      targetType,
      targetId,
      resolvedVariantCount: 1,
      ready: true,
    });
  });

  it("reports exact gaps when matching rules do not cover the complete purchase window", () => {
    const readiness = analyzePurchaseEntryCatalog({
      ...window,
      products,
      rules: [
        rule({ endsAt: "2035-06-15T04:00:00.000Z" }),
        rule({
          name: "Late rate",
          startsAt: "2035-06-16T04:00:00.000Z",
          targetType: "PRODUCT",
          targetId: "road-kit",
        }),
      ],
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.uncoveredVariants[0]).toMatchObject({
      productSlug: "road-kit",
      variantSku: "ROAD-KIT-01",
      gaps: [{
        startsAt: "2035-06-15T04:00:00.000Z",
        endsAt: "2035-06-16T04:00:00.000Z",
      }],
    });
  });
});
