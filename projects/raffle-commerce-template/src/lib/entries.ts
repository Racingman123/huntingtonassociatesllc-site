export type EntryCalculationInput = {
  unitPriceCents: number;
  quantity: number;
  discountCents?: number;
  baseEntriesPerDollar: number;
  productMultiplier?: number;
  purchaseRuleMultiplier?: number;
  campaignMultiplier?: number;
  cap?: bigint | null;
};

export type EntryCalculation = {
  qualifyingCents: number;
  qualifyingWholeDollars: number;
  baseEntries: bigint;
  productMultiplier: number;
  purchaseRuleMultiplier: number;
  campaignMultiplier: number;
  finalEntries: bigint;
  snapshot: {
    schemaVersion: 1;
    roundingScope: "LINE";
    unitPriceCents: number;
    quantity: number;
    discountCents: number;
    qualifyingCents: number;
    qualifyingWholeDollars: number;
    baseEntriesPerDollar: number;
    productMultiplier: number;
    purchaseRuleMultiplier: number;
    campaignMultiplier: number;
    capped: boolean;
    finalEntries: string;
  };
};

function assertPositiveInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
}

export function calculateEntries(input: EntryCalculationInput): EntryCalculation {
  assertPositiveInteger(input.unitPriceCents, "unitPriceCents");
  assertPositiveInteger(input.quantity, "quantity");
  assertPositiveInteger(input.baseEntriesPerDollar, "baseEntriesPerDollar");

  const discountCents = input.discountCents ?? 0;
  if (!Number.isSafeInteger(discountCents) || discountCents < 0) {
    throw new Error("discountCents must be a non-negative safe integer");
  }

  const productMultiplier = input.productMultiplier ?? 1;
  const purchaseRuleMultiplier = input.purchaseRuleMultiplier ?? 1;
  const campaignMultiplier = input.campaignMultiplier ?? 1;
  assertPositiveInteger(productMultiplier, "productMultiplier");
  assertPositiveInteger(purchaseRuleMultiplier, "purchaseRuleMultiplier");
  assertPositiveInteger(campaignMultiplier, "campaignMultiplier");

  const lineSubtotal = input.unitPriceCents * input.quantity;
  if (!Number.isSafeInteger(lineSubtotal)) {
    throw new Error("line subtotal exceeds safe integer precision");
  }

  const qualifyingCents = Math.max(0, lineSubtotal - discountCents);
  const qualifyingWholeDollars = Math.floor(qualifyingCents / 100);
  const baseEntries = BigInt(qualifyingWholeDollars) * BigInt(input.baseEntriesPerDollar);
  const uncapped = baseEntries
    * BigInt(productMultiplier)
    * BigInt(purchaseRuleMultiplier)
    * BigInt(campaignMultiplier);
  const finalEntries = input.cap != null && uncapped > input.cap ? input.cap : uncapped;

  return {
    qualifyingCents,
    qualifyingWholeDollars,
    baseEntries,
    productMultiplier,
    purchaseRuleMultiplier,
    campaignMultiplier,
    finalEntries,
    snapshot: {
      schemaVersion: 1,
      roundingScope: "LINE",
      unitPriceCents: input.unitPriceCents,
      quantity: input.quantity,
      discountCents,
      qualifyingCents,
      qualifyingWholeDollars,
      baseEntriesPerDollar: input.baseEntriesPerDollar,
      productMultiplier,
      purchaseRuleMultiplier,
      campaignMultiplier,
      capped: finalEntries !== uncapped,
      finalEntries: finalEntries.toString(),
    },
  };
}

export function sumEntries(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}
