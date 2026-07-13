import { describe, expect, it } from "vitest";
import { allocateRefund } from "./allocation";

describe("refund allocation", () => {
  const lines = [
    { lineId: "a", originalAmountCents: 4900, originalEntries: 24_500n, previouslyRefundedCents: 0, previouslyReversedEntries: 0n },
    { lineId: "b", originalAmountCents: 15900, originalEntries: 39_750n, previouslyRefundedCents: 0, previouslyReversedEntries: 0n },
  ];

  it("allocates cents deterministically and reverses original entries proportionally", () => {
    const result = allocateRefund(lines, 10_000);
    expect(result.reduce((sum, item) => sum + item.amountCents, 0)).toBe(10_000);
    expect(result.reduce((sum, item) => sum + item.entriesToReverse, 0n)).toBeGreaterThan(0n);
  });

  it("multiple partial refunds converge exactly to a full reversal", () => {
    const first = allocateRefund(lines, 10_000);
    const updated = lines.map((line) => {
      const allocated = first.find((item) => item.lineId === line.lineId);
      return {
        ...line,
        previouslyRefundedCents: allocated?.amountCents ?? 0,
        previouslyReversedEntries: allocated?.entriesToReverse ?? 0n,
      };
    });
    const second = allocateRefund(updated, 10_800);
    const totalReversed = first.concat(second).reduce((sum, item) => sum + item.entriesToReverse, 0n);
    expect(totalReversed).toBe(64_250n);
  });

  it("rejects over-refunds", () => {
    expect(() => allocateRefund(lines, 20_801)).toThrow(/exceeds/);
  });
});
