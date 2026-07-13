import { calculateEntries, type EntryCalculation } from "./entries";

export const PURCHASE_ENTRY_TARGET_TYPES = [
  "ALL",
  "CATEGORY",
  "COLLECTION",
  "PRODUCT",
  "VARIANT",
] as const;

export type PurchaseEntryTargetType = (typeof PURCHASE_ENTRY_TARGET_TYPES)[number];

export type PurchaseEntryRuleLike = {
  id: string;
  name: string;
  ruleType: string;
  targetType: string;
  targetId: string | null;
  entriesPerDollar: number;
  multiplierNumerator: number;
  multiplierDenominator: number;
  stackPriority: number;
  startsAt: Date | string | null;
  endsAt: Date | string | null;
  version: number;
  active: boolean;
};

export type PurchaseEntryTarget = {
  productId: string;
  productSlug: string;
  category: string;
  collectionIds?: readonly string[];
  collectionSlugs?: readonly string[];
  variantId: string;
  variantSku: string;
};

export type PurchaseEntryRuleSnapshot = {
  schemaVersion: 1;
  semantics: "MULTIPLY_DISTINCT_PRIORITIES";
  evaluatedAt: string;
  baseEntriesPerCurrencyUnit: number;
  catalogProductMultiplier: number;
  campaignMultiplier: number;
  purchaseRuleMultiplier: number;
  effectiveMultiplier: number;
  matchedRules: Array<{
    id: string;
    name: string;
    version: number;
    targetType: PurchaseEntryTargetType;
    targetId: string | null;
    stackPriority: number;
    entriesPerCurrencyUnit: number;
    multiplierNumerator: number;
    multiplierDenominator: number;
    factor: number;
  }>;
};

export type PurchaseEntryRuleResolution = {
  purchaseRuleMultiplier: number;
  effectiveMultiplier: number;
  snapshot: PurchaseEntryRuleSnapshot;
};

export type StorefrontEntryQuote = {
  unitPriceCents: number;
  baseEntriesPerCurrencyUnit: number;
  catalogProductMultiplier: number;
  purchaseRuleMultiplier: number;
  campaignMultiplier: number;
  effectiveMultiplier: number;
  ruleSnapshot: PurchaseEntryRuleSnapshot;
};

function positiveSafeInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function multiplySafe(left: number, right: number, name: string) {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} exceeds safe integer precision`);
  }
  return value;
}

function instant(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Entry rule contains an invalid timestamp");
  return date;
}

function targetMatches(rule: PurchaseEntryRuleLike, target: PurchaseEntryTarget) {
  switch (rule.targetType) {
    case "ALL":
      if (rule.targetId !== null) throw new Error(`ALL entry rule '${rule.id}' must not specify a target`);
      return true;
    case "CATEGORY":
      if (!rule.targetId) throw new Error(`CATEGORY entry rule '${rule.id}' is missing its target`);
      return rule.targetId === target.category;
    case "COLLECTION":
      if (!rule.targetId) throw new Error(`COLLECTION entry rule '${rule.id}' is missing its target`);
      return [...(target.collectionIds ?? []), ...(target.collectionSlugs ?? [])].includes(rule.targetId);
    case "PRODUCT":
      if (!rule.targetId) throw new Error(`PRODUCT entry rule '${rule.id}' is missing its target`);
      return rule.targetId === target.productId || rule.targetId === target.productSlug;
    case "VARIANT":
      if (!rule.targetId) throw new Error(`VARIANT entry rule '${rule.id}' is missing its target`);
      return rule.targetId === target.variantId || rule.targetId === target.variantSku;
    default:
      throw new Error(`Entry rule '${rule.id}' has unsupported target type '${rule.targetType}'`);
  }
}

/**
 * Published purchase rules use explicit multiplicative stacking. Every active,
 * matching rule contributes `entriesPerCurrencyUnit × numerator/denominator`;
 * rules at distinct priorities stack in ascending priority order. More than one
 * matching rule at the same priority is ambiguous and therefore fails closed.
 * The campaign base rate, catalog product multiplier, and scheduled campaign
 * multiplier are then each combined exactly once.
 */
export function resolvePurchaseEntryRules(input: {
  at: Date;
  campaignBaseEntriesPerCurrencyUnit: number;
  catalogProductMultiplier: number;
  campaignMultiplier: number;
  rules: readonly PurchaseEntryRuleLike[];
  target: PurchaseEntryTarget;
}): PurchaseEntryRuleResolution {
  positiveSafeInteger(input.campaignBaseEntriesPerCurrencyUnit, "campaignBaseEntriesPerCurrencyUnit");
  positiveSafeInteger(input.catalogProductMultiplier, "catalogProductMultiplier");
  positiveSafeInteger(input.campaignMultiplier, "campaignMultiplier");
  if (!Number.isFinite(input.at.getTime())) throw new Error("Entry rule evaluation time is invalid");

  const matched = input.rules.filter((rule) => {
    if (!rule.active || rule.ruleType !== "MONEY_RATE") return false;
    if (rule.startsAt && input.at < instant(rule.startsAt)) return false;
    if (rule.endsAt && input.at >= instant(rule.endsAt)) return false;
    return targetMatches(rule, input.target);
  }).sort((left, right) => (
    left.stackPriority - right.stackPriority || left.id.localeCompare(right.id)
  ));
  if (!matched.length) {
    throw new Error("No active purchase-entry rule covers this product option");
  }

  const priorities = new Set<number>();
  let purchaseRuleMultiplier = 1;
  const matchedRules: PurchaseEntryRuleSnapshot["matchedRules"] = [];
  for (const rule of matched) {
    if (!PURCHASE_ENTRY_TARGET_TYPES.includes(rule.targetType as PurchaseEntryTargetType)) {
      throw new Error(`Entry rule '${rule.id}' has unsupported target type '${rule.targetType}'`);
    }
    if (priorities.has(rule.stackPriority)) {
      throw new Error(`Ambiguous purchase-entry rules match at priority ${rule.stackPriority}`);
    }
    priorities.add(rule.stackPriority);
    positiveSafeInteger(rule.entriesPerDollar, `entriesPerDollar for rule '${rule.id}'`);
    positiveSafeInteger(rule.multiplierNumerator, `multiplierNumerator for rule '${rule.id}'`);
    positiveSafeInteger(rule.multiplierDenominator, `multiplierDenominator for rule '${rule.id}'`);
    if (rule.multiplierNumerator % rule.multiplierDenominator !== 0) {
      throw new Error(`Purchase-entry rule '${rule.id}' does not resolve to an integral multiplier`);
    }
    const factor = multiplySafe(
      rule.entriesPerDollar,
      rule.multiplierNumerator / rule.multiplierDenominator,
      `factor for purchase-entry rule '${rule.id}'`,
    );
    purchaseRuleMultiplier = multiplySafe(
      purchaseRuleMultiplier,
      factor,
      "stacked purchase-entry rule multiplier",
    );
    matchedRules.push({
      id: rule.id,
      name: rule.name,
      version: rule.version,
      targetType: rule.targetType as PurchaseEntryTargetType,
      targetId: rule.targetId,
      stackPriority: rule.stackPriority,
      entriesPerCurrencyUnit: rule.entriesPerDollar,
      multiplierNumerator: rule.multiplierNumerator,
      multiplierDenominator: rule.multiplierDenominator,
      factor,
    });
  }

  const effectiveMultiplier = multiplySafe(
    multiplySafe(input.catalogProductMultiplier, purchaseRuleMultiplier, "product and entry-rule multiplier"),
    input.campaignMultiplier,
    "effective entry multiplier",
  );
  return {
    purchaseRuleMultiplier,
    effectiveMultiplier,
    snapshot: {
      schemaVersion: 1,
      semantics: "MULTIPLY_DISTINCT_PRIORITIES",
      evaluatedAt: input.at.toISOString(),
      baseEntriesPerCurrencyUnit: input.campaignBaseEntriesPerCurrencyUnit,
      catalogProductMultiplier: input.catalogProductMultiplier,
      campaignMultiplier: input.campaignMultiplier,
      purchaseRuleMultiplier,
      effectiveMultiplier,
      matchedRules,
    },
  };
}

export function createStorefrontEntryQuote(input: {
  unitPriceCents: number;
  at: Date;
  campaignBaseEntriesPerCurrencyUnit: number;
  catalogProductMultiplier: number;
  campaignMultiplier: number;
  rules: readonly PurchaseEntryRuleLike[];
  target: PurchaseEntryTarget;
}): StorefrontEntryQuote {
  positiveSafeInteger(input.unitPriceCents, "unitPriceCents");
  const resolution = resolvePurchaseEntryRules(input);
  return {
    unitPriceCents: input.unitPriceCents,
    baseEntriesPerCurrencyUnit: input.campaignBaseEntriesPerCurrencyUnit,
    catalogProductMultiplier: input.catalogProductMultiplier,
    purchaseRuleMultiplier: resolution.purchaseRuleMultiplier,
    campaignMultiplier: input.campaignMultiplier,
    effectiveMultiplier: resolution.effectiveMultiplier,
    ruleSnapshot: resolution.snapshot,
  };
}

export function calculateStorefrontEntryQuote(
  quote: StorefrontEntryQuote,
  quantity: number,
): EntryCalculation {
  return calculateEntries({
    unitPriceCents: quote.unitPriceCents,
    quantity,
    baseEntriesPerDollar: quote.baseEntriesPerCurrencyUnit,
    productMultiplier: quote.catalogProductMultiplier,
    purchaseRuleMultiplier: quote.purchaseRuleMultiplier,
    campaignMultiplier: quote.campaignMultiplier,
  });
}
