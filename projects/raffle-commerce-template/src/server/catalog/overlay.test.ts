import { describe, expect, test } from "vitest";
import {
  catalogOverlayChecksum,
  parseCatalogOverlay,
  stableJson,
} from "./overlay";

function validOverlay() {
  return {
    schemaVersion: 1,
    targetTenantSlug: "northstar",
    releaseName: "Test catalog release",
    currency: "USD",
    products: [
      {
        slug: "trail-tee",
        title: "Trail Tee",
        subtitle: null,
        description: "A physical product with active size variants.",
        productType: "PHYSICAL",
        category: "Apparel",
        priceCents: 3800,
        compareAtCents: 4400,
        image: "/brand/products/trail-tee.webp",
        secondaryImage: null,
        badge: "NEW",
        entryMultiplier: 2,
        featured: true,
        inventory: 20,
        tags: ["Apparel", "Launch"],
        variants: [
          { sku: "TEE-M", title: "Medium", options: { size: "M" }, priceCents: null, inventory: 10, status: "ACTIVE" },
          { sku: "TEE-L", title: "Large", options: { size: "L" }, priceCents: 4000, inventory: 10, status: "ACTIVE" },
        ],
        subscriptionPlan: null,
      },
      {
        slug: "basecamp-membership",
        title: "Basecamp Membership",
        subtitle: "Monthly access",
        description: "A recurring monthly membership.",
        productType: "MEMBERSHIP",
        category: "Membership",
        priceCents: 2500,
        compareAtCents: null,
        image: "/brand/products/membership.webp",
        secondaryImage: null,
        badge: null,
        entryMultiplier: 1,
        featured: true,
        inventory: 1000,
        tags: ["Membership"],
        variants: [
          { sku: "MEMBER-MONTH", title: "Monthly", options: {}, priceCents: null, inventory: 1000, status: "ACTIVE" },
        ],
        subscriptionPlan: {
          name: "Basecamp Monthly",
          interval: "MONTH",
          intervalCount: 1,
          priceCents: 2500,
          currency: "USD",
          baseEntries: "25",
          providerPriceId: "price_test_basecamp",
        },
      },
    ],
    collections: [{
      slug: "new-releases",
      title: "New Releases",
      description: "Catalog release order.",
      image: "/brand/collections/new.webp",
      sortOrder: 0,
      productSlugs: ["trail-tee", "basecamp-membership"],
    }],
  };
}

describe("catalog overlay validation", () => {
  test("accepts a complete mixed catalog and creates a deterministic checksum", () => {
    const parsed = parseCatalogOverlay(validOverlay());
    expect(parsed.products[1]!.subscriptionPlan?.baseEntries).toBe("25");
    expect(catalogOverlayChecksum(parsed)).toMatch(/^[a-f0-9]{64}$/);
    expect(stableJson({ z: { b: 2, a: 1 }, a: 0 })).toBe('{"a":0,"z":{"a":1,"b":2}}');
  });

  test("rejects duplicate SKUs ignoring case and duplicate option combinations", () => {
    const input = validOverlay();
    input.products[0]!.variants[1]!.sku = "tee-m";
    input.products[0]!.variants[1]!.options = { size: "M" };
    expect(() => parseCatalogOverlay(input)).toThrow(/duplicate SKU|unique option/i);
  });

  test("requires exactly one plan on membership products and none on ordinary products", () => {
    const missing = validOverlay();
    missing.products[1]!.subscriptionPlan = null;
    expect(() => parseCatalogOverlay(missing)).toThrow(/requires exactly one subscription plan/i);

    const ordinary = validOverlay();
    ordinary.products[0]!.subscriptionPlan = { ...ordinary.products[1]!.subscriptionPlan! };
    expect(() => parseCatalogOverlay(ordinary)).toThrow(/ordinary products/i);
  });

  test("rejects currency drift, price drift, and unknown collection members", () => {
    const input = validOverlay();
    input.products[1]!.subscriptionPlan!.currency = "EUR";
    input.products[1]!.subscriptionPlan!.priceCents = 2600;
    input.collections[0]!.productSlugs.push("missing-product");
    expect(() => parseCatalogOverlay(input)).toThrow(/currency|prices must match|unknown product/i);
  });

  test("rejects negative cents, unsafe assets, and products without active variants", () => {
    const input = validOverlay();
    input.products[0]!.priceCents = -1;
    input.products[0]!.image = "https://example.test/tracker.png";
    input.products[0]!.variants = [];
    expect(() => parseCatalogOverlay(input)).toThrow(/greater than or equal|root-relative|too small/i);
  });

  test("rejects a physical product aggregate that disagrees with variant inventory", () => {
    const input = validOverlay();
    input.products[0]!.inventory = 21;
    expect(() => parseCatalogOverlay(input)).toThrow(/sum of its active variant inventory/i);
  });
});
