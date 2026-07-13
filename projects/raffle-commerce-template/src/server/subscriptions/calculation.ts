/**
 * Pure subscription-domain calculations. This module deliberately has no
 * database or Next.js dependency so configuration can be verified in tests,
 * importers, and deployment checks.
 */

export const billingIntervals = ["DAY", "WEEK", "MONTH", "YEAR"] as const;

export type BillingInterval = (typeof billingIntervals)[number];

export type MembershipBand = {
  id: string;
  minimumSettledCycles: number;
  maximumSettledCycles: number | null;
  fixedEntries: bigint;
  multiplierNumerator: number;
  multiplierDenominator: number;
};

export type RenewalCalculationInput = {
  priceCents: number;
  currency: string;
  interval: BillingInterval;
  intervalCount: number;
  settledCycleCount: number;
  currentPeriodStartsAt: Date;
  currentPeriodEndsAt: Date;
  bands: readonly MembershipBand[];
  campaignMultiplier?: number;
  capturedPeriod?: { startsAt: Date; endsAt: Date };
  remainingEntryCapacity?: bigint | null;
};

export type RenewalCalculation = {
  cycleNumber: number;
  priceCents: number;
  currency: string;
  periodStartsAt: Date;
  periodEndsAt: Date;
  band: MembershipBand;
  baseEntries: bigint;
  uncappedEntries: bigint;
  awardedEntries: bigint;
  capApplied: boolean;
  snapshot: {
    schemaVersion: 1;
    calculation: "MEMBERSHIP_TENURE_BAND";
    cycleNumber: number;
    settledCyclesBeforeRenewal: number;
    priceCents: number;
    currency: string;
    interval: BillingInterval;
    intervalCount: number;
    periodStartsAt: string;
    periodEndsAt: string;
    bandId: string;
    minimumSettledCycles: number;
    maximumSettledCycles: number | null;
    fixedEntries: string;
    multiplierNumerator: number;
    multiplierDenominator: number;
    campaignMultiplier: number;
    rounding: "FLOOR_TO_WHOLE_ENTRY";
    uncappedEntries: string;
    capApplied: boolean;
    awardedEntries: string;
  };
};

function assertNonNegativeSafeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function assertPositiveSafeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
}

function assertValidDate(value: Date, field: string) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${field} must be a valid Date`);
  }
}

function assertValidBand(band: MembershipBand) {
  if (!band.id) throw new Error("Membership entry band id is required");
  assertNonNegativeSafeInteger(band.minimumSettledCycles, "minimumSettledCycles");
  if (band.maximumSettledCycles !== null) {
    assertNonNegativeSafeInteger(band.maximumSettledCycles, "maximumSettledCycles");
    if (band.maximumSettledCycles < band.minimumSettledCycles) {
      throw new Error(`Membership entry band ${band.id} has an invalid cycle range`);
    }
  }
  if (band.fixedEntries < 0n) {
    throw new Error(`Membership entry band ${band.id} has negative fixed entries`);
  }
  assertPositiveSafeInteger(band.multiplierNumerator, "multiplierNumerator");
  assertPositiveSafeInteger(band.multiplierDenominator, "multiplierDenominator");
}

/**
 * Selects the single band applying before the next captured cycle is posted.
 * A first settlement therefore uses tenure 0, the second tenure 1, and so on.
 * Ambiguous overlaps fail closed instead of silently changing an entry award.
 */
export function selectMembershipEntryBand(
  bands: readonly MembershipBand[],
  settledCycleCount: number,
): MembershipBand {
  assertNonNegativeSafeInteger(settledCycleCount, "settledCycleCount");
  for (const band of bands) assertValidBand(band);

  const matching = bands.filter((band) => (
    band.minimumSettledCycles <= settledCycleCount
    && (band.maximumSettledCycles === null || settledCycleCount <= band.maximumSettledCycles)
  ));

  if (matching.length === 0) {
    throw new Error(`No membership entry band covers settled cycle ${settledCycleCount}`);
  }
  if (matching.length > 1) {
    throw new Error(`Membership entry bands overlap at settled cycle ${settledCycleCount}`);
  }
  return matching[0];
}

function daysInUtcMonth(year: number, zeroBasedMonth: number) {
  return new Date(Date.UTC(year, zeroBasedMonth + 1, 0)).getUTCDate();
}

function addUtcMonths(value: Date, months: number) {
  const result = new Date(value.getTime());
  const originalDay = result.getUTCDate();
  const absoluteMonth = result.getUTCFullYear() * 12 + result.getUTCMonth() + months;
  const targetYear = Math.floor(absoluteMonth / 12);
  const targetMonth = absoluteMonth - targetYear * 12;
  const targetDay = Math.min(originalDay, daysInUtcMonth(targetYear, targetMonth));

  // Move to day one before changing the month so dates such as January 31 do
  // not overflow into March before the target day is clamped.
  result.setUTCDate(1);
  result.setUTCFullYear(targetYear, targetMonth, targetDay);
  return result;
}

/** Adds a configured billing interval using UTC calendar arithmetic. */
export function calculatePeriodEnd(
  periodStartsAt: Date,
  interval: BillingInterval,
  intervalCount: number,
) {
  assertValidDate(periodStartsAt, "periodStartsAt");
  assertPositiveSafeInteger(intervalCount, "intervalCount");

  let result: Date;
  switch (interval) {
    case "DAY":
      result = new Date(periodStartsAt.getTime());
      result.setUTCDate(result.getUTCDate() + intervalCount);
      break;
    case "WEEK":
      result = new Date(periodStartsAt.getTime());
      result.setUTCDate(result.getUTCDate() + intervalCount * 7);
      break;
    case "MONTH":
      result = addUtcMonths(periodStartsAt, intervalCount);
      break;
    case "YEAR":
      result = addUtcMonths(periodStartsAt, intervalCount * 12);
      break;
    default: {
      const exhaustive: never = interval;
      throw new Error(`Unsupported billing interval: ${exhaustive}`);
    }
  }

  if (!Number.isFinite(result.getTime()) || result <= periodStartsAt) {
    throw new Error("Calculated billing period end is invalid");
  }
  return result;
}

/**
 * Produces the immutable monetary, period, tenure, rational-multiplier, and cap
 * calculation used by the renewal order, cycle, entitlement, and ledger event.
 */
export function calculateRenewal(input: RenewalCalculationInput): RenewalCalculation {
  assertPositiveSafeInteger(input.priceCents, "priceCents");
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new Error("currency must be a three-letter uppercase code");
  }
  assertPositiveSafeInteger(input.intervalCount, "intervalCount");
  assertNonNegativeSafeInteger(input.settledCycleCount, "settledCycleCount");
  assertValidDate(input.currentPeriodStartsAt, "currentPeriodStartsAt");
  assertValidDate(input.currentPeriodEndsAt, "currentPeriodEndsAt");
  if (input.currentPeriodEndsAt <= input.currentPeriodStartsAt) {
    throw new Error("current subscription period must have a positive duration");
  }
  if (input.remainingEntryCapacity != null && input.remainingEntryCapacity < 0n) {
    throw new Error("remainingEntryCapacity must be non-negative");
  }
  const campaignMultiplier = input.campaignMultiplier ?? 1;
  assertPositiveSafeInteger(campaignMultiplier, "campaignMultiplier");

  const band = selectMembershipEntryBand(input.bands, input.settledCycleCount);
  // The first provider capture pays the period created with the subscription.
  // Later captures advance from the end of the already-paid current period.
  // Keeping this distinction prevents an initial charge from accidentally
  // being recorded as payment for a future, not-yet-started period.
  const initialSettlement = input.settledCycleCount === 0;
  const periodStartsAt = input.capturedPeriod
    ? new Date(input.capturedPeriod.startsAt.getTime())
    : new Date((initialSettlement ? input.currentPeriodStartsAt : input.currentPeriodEndsAt).getTime());
  const periodEndsAt = input.capturedPeriod
    ? new Date(input.capturedPeriod.endsAt.getTime())
    : initialSettlement
      ? new Date(input.currentPeriodEndsAt.getTime())
      : calculatePeriodEnd(periodStartsAt, input.interval, input.intervalCount);
  assertValidDate(periodStartsAt, "periodStartsAt");
  assertValidDate(periodEndsAt, "periodEndsAt");
  if (periodEndsAt <= periodStartsAt) throw new Error("captured period must have a positive duration");
  const scaledEntries = band.fixedEntries
    * BigInt(band.multiplierNumerator)
    * BigInt(campaignMultiplier);
  const uncappedEntries = scaledEntries / BigInt(band.multiplierDenominator);
  const remainingCapacity = input.remainingEntryCapacity;
  const awardedEntries = remainingCapacity != null && uncappedEntries > remainingCapacity
    ? remainingCapacity
    : uncappedEntries;
  const cycleNumber = input.settledCycleCount + 1;

  return {
    cycleNumber,
    priceCents: input.priceCents,
    currency: input.currency,
    periodStartsAt,
    periodEndsAt,
    band,
    baseEntries: band.fixedEntries,
    uncappedEntries,
    awardedEntries,
    capApplied: awardedEntries !== uncappedEntries,
    snapshot: {
      schemaVersion: 1,
      calculation: "MEMBERSHIP_TENURE_BAND",
      cycleNumber,
      settledCyclesBeforeRenewal: input.settledCycleCount,
      priceCents: input.priceCents,
      currency: input.currency,
      interval: input.interval,
      intervalCount: input.intervalCount,
      periodStartsAt: periodStartsAt.toISOString(),
      periodEndsAt: periodEndsAt.toISOString(),
      bandId: band.id,
      minimumSettledCycles: band.minimumSettledCycles,
      maximumSettledCycles: band.maximumSettledCycles,
      fixedEntries: band.fixedEntries.toString(),
      multiplierNumerator: band.multiplierNumerator,
      multiplierDenominator: band.multiplierDenominator,
      campaignMultiplier,
      rounding: "FLOOR_TO_WHOLE_ENTRY",
      uncappedEntries: uncappedEntries.toString(),
      capApplied: awardedEntries !== uncappedEntries,
      awardedEntries: awardedEntries.toString(),
    },
  };
}
