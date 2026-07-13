export type RefundableLine = {
  lineId: string;
  originalAmountCents: number;
  originalEntries: bigint;
  previouslyRefundedCents: number;
  previouslyReversedEntries: bigint;
};

export type RefundAllocation = {
  lineId: string;
  amountCents: number;
  entriesToReverse: bigint;
};

export function allocateRefund(lines: RefundableLine[], requestedAmountCents: number): RefundAllocation[] {
  if (!Number.isSafeInteger(requestedAmountCents) || requestedAmountCents <= 0) {
    throw new Error("Refund amount must be a positive integer number of cents");
  }
  const available = lines.map((line) => {
    if (!Number.isSafeInteger(line.originalAmountCents) || line.originalAmountCents <= 0) throw new Error("Invalid original line amount");
    if (!Number.isSafeInteger(line.previouslyRefundedCents) || line.previouslyRefundedCents < 0) throw new Error("Invalid prior refund amount");
    const remainingCents = line.originalAmountCents - line.previouslyRefundedCents;
    if (remainingCents < 0 || line.previouslyReversedEntries < 0n || line.previouslyReversedEntries > line.originalEntries) {
      throw new Error("Prior refund state exceeds the original line");
    }
    return { ...line, remainingCents };
  }).filter((line) => line.remainingCents > 0);
  const totalRemaining = available.reduce((sum, line) => sum + line.remainingCents, 0);
  if (requestedAmountCents > totalRemaining) throw new Error("Refund exceeds the remaining refundable merchandise amount");

  const proportional = available.map((line) => {
    const numerator = BigInt(requestedAmountCents) * BigInt(line.remainingCents);
    return {
      ...line,
      amountCents: Number(numerator / BigInt(totalRemaining)),
      remainder: numerator % BigInt(totalRemaining),
    };
  });
  let centsLeft = requestedAmountCents - proportional.reduce((sum, line) => sum + line.amountCents, 0);
  const remainderOrder = [...proportional].sort((a, b) => {
    if (a.remainder === b.remainder) return a.lineId.localeCompare(b.lineId);
    return a.remainder > b.remainder ? -1 : 1;
  });
  for (const line of remainderOrder) {
    if (centsLeft <= 0) break;
    if (line.amountCents < line.remainingCents) {
      line.amountCents += 1;
      centsLeft -= 1;
    }
  }
  if (centsLeft !== 0) throw new Error("Unable to allocate refund cents");

  return proportional
    .filter((line) => line.amountCents > 0)
    .map((line) => {
      const cumulativeRefunded = line.previouslyRefundedCents + line.amountCents;
      const targetCumulativeReversal = cumulativeRefunded === line.originalAmountCents
        ? line.originalEntries
        : (line.originalEntries * BigInt(cumulativeRefunded)) / BigInt(line.originalAmountCents);
      const entriesToReverse = targetCumulativeReversal - line.previouslyReversedEntries;
      if (entriesToReverse < 0n) throw new Error("Calculated entry reversal would be negative");
      return { lineId: line.lineId, amountCents: line.amountCents, entriesToReverse };
    });
}
