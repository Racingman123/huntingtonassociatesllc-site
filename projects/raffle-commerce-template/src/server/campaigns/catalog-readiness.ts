type PurchaseRule = {
  name: string;
  targetType: "ALL" | "CATEGORY" | "COLLECTION" | "PRODUCT" | "VARIANT";
  targetId: string | null;
  startsAt: string | null;
  endsAt: string | null;
  active: boolean;
};

type CatalogVariant = {
  id: string;
  sku: string;
};

type CatalogProduct = {
  id: string;
  slug: string;
  category: string;
  productType: string;
  variants: readonly CatalogVariant[];
  collections: ReadonlyArray<{
    collection: { id: string; slug: string };
  }>;
};

export type PurchaseEntryCatalogReadiness = {
  ready: boolean;
  purchasableProductCount: number;
  purchasableVariantCount: number;
  targetChecks: Array<{
    ruleIndex: number;
    ruleName: string;
    targetType: PurchaseRule["targetType"];
    targetId: string;
    resolvedVariantCount: number;
    ready: boolean;
  }>;
  productsWithoutActiveVariants: Array<{
    productId: string;
    productSlug: string;
  }>;
  uncoveredVariants: Array<{
    productId: string;
    productSlug: string;
    variantId: string;
    variantSku: string;
    gaps: Array<{ startsAt: string; endsAt: string }>;
  }>;
  issues: string[];
};

function ruleMatches(
  rule: PurchaseRule,
  product: CatalogProduct,
  variant: CatalogVariant,
) {
  switch (rule.targetType) {
    case "ALL":
      return rule.targetId === null;
    case "CATEGORY":
      return rule.targetId === product.category;
    case "COLLECTION":
      return product.collections.some(({ collection }) => (
        rule.targetId === collection.id || rule.targetId === collection.slug
      ));
    case "PRODUCT":
      return rule.targetId === product.id || rule.targetId === product.slug;
    case "VARIANT":
      return rule.targetId === variant.id || rule.targetId === variant.sku;
  }
}

function coverageGaps(
  campaignStart: number,
  campaignEnd: number,
  intervals: Array<{ startsAt: number; endsAt: number }>,
) {
  const gaps: Array<{ startsAt: string; endsAt: string }> = [];
  let cursor = campaignStart;
  for (const interval of intervals.sort((left, right) => (
    left.startsAt - right.startsAt || left.endsAt - right.endsAt
  ))) {
    if (interval.endsAt <= cursor) continue;
    if (interval.startsAt > cursor) {
      gaps.push({
        startsAt: new Date(cursor).toISOString(),
        endsAt: new Date(Math.min(interval.startsAt, campaignEnd)).toISOString(),
      });
    }
    cursor = Math.max(cursor, interval.endsAt);
    if (cursor >= campaignEnd) break;
  }
  if (cursor < campaignEnd) {
    gaps.push({
      startsAt: new Date(cursor).toISOString(),
      endsAt: new Date(campaignEnd).toISOString(),
    });
  }
  return gaps.filter((gap) => gap.startsAt !== gap.endsAt);
}

/**
 * Checks the exact catalog that ordinary checkout can sell. Membership plans
 * intentionally do not participate: they are enrolled through the recurring
 * billing flow and use MembershipEntryBand records instead.
 */
export function analyzePurchaseEntryCatalog(input: {
  purchaseStartsAt: string;
  purchaseEndsAt: string;
  rules: readonly PurchaseRule[];
  products: readonly CatalogProduct[];
}): PurchaseEntryCatalogReadiness {
  const campaignStart = Date.parse(input.purchaseStartsAt);
  const campaignEnd = Date.parse(input.purchaseEndsAt);
  if (!Number.isFinite(campaignStart) || !Number.isFinite(campaignEnd) || campaignStart >= campaignEnd) {
    throw new Error("Purchase-entry catalog analysis received an invalid campaign window");
  }

  const products = input.products.filter((product) => product.productType !== "MEMBERSHIP");
  const productsWithoutActiveVariants = products.filter((product) => (
    product.variants.length === 0
  )).map((product) => ({
    productId: product.id,
    productSlug: product.slug,
  }));
  const options = products.flatMap((product) => (
    product.variants.map((variant) => ({ product, variant }))
  ));
  const targetChecks = input.rules.flatMap((rule, ruleIndex) => {
    if (rule.targetType === "ALL") return [];
    const resolvedVariantCount = options.filter(({ product, variant }) => (
      ruleMatches(rule, product, variant)
    )).length;
    return [{
      ruleIndex,
      ruleName: rule.name,
      targetType: rule.targetType,
      targetId: rule.targetId ?? "",
      resolvedVariantCount,
      ready: resolvedVariantCount > 0,
    }];
  });

  const uncoveredVariants = options.flatMap(({ product, variant }) => {
    const intervals = input.rules.filter((rule) => (
      rule.active && ruleMatches(rule, product, variant)
    )).map((rule) => ({
      startsAt: rule.startsAt ? Date.parse(rule.startsAt) : campaignStart,
      endsAt: rule.endsAt ? Date.parse(rule.endsAt) : campaignEnd,
    }));
    const gaps = coverageGaps(campaignStart, campaignEnd, intervals);
    return gaps.length ? [{
      productId: product.id,
      productSlug: product.slug,
      variantId: variant.id,
      variantSku: variant.sku,
      gaps,
    }] : [];
  });

  const issues: string[] = [];
  if (!options.length) {
    issues.push("The tenant has no active purchasable non-membership product variants");
  }
  for (const product of productsWithoutActiveVariants) {
    issues.push(`Active product '${product.productSlug}' has no active purchasable variant`);
  }
  for (const check of targetChecks) {
    if (!check.ready) {
      issues.push(
        `Purchase-entry rule '${check.ruleName}' ${check.targetType} target '${check.targetId}' does not resolve to an active purchasable non-membership variant`,
      );
    }
  }
  for (const uncovered of uncoveredVariants) {
    const first = uncovered.gaps[0]!;
    issues.push(
      `Product '${uncovered.productSlug}' variant '${uncovered.variantSku}' has no active purchase-entry rule from ${first.startsAt} through ${first.endsAt}`,
    );
  }

  return {
    ready: issues.length === 0,
    purchasableProductCount: products.filter((product) => product.variants.length > 0).length,
    purchasableVariantCount: options.length,
    targetChecks,
    productsWithoutActiveVariants,
    uncoveredVariants,
    issues,
  };
}

export function assertPurchaseEntryCatalogReady(readiness: PurchaseEntryCatalogReadiness) {
  if (!readiness.ready) {
    throw new Error(`Purchase-entry catalog is not publishable: ${readiness.issues.join("; ")}`);
  }
}
