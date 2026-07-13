import { describe, expect, it } from "vitest";
import { findSnapshotRange, HmacCounterStream, selectCandidates, uniformBigInt } from "./random";

describe("draw selection", () => {
  const rows = [
    { entryAccountId: "a", rangeStart: 1n, rangeEnd: 10n },
    { entryAccountId: "b", rangeStart: 11n, rangeEnd: 50n },
    { entryAccountId: "c", rangeStart: 51n, rangeEnd: 100n },
  ];

  it("finds boundary entry numbers using cumulative ranges", () => {
    expect(findSnapshotRange(rows, 1n).entryAccountId).toBe("a");
    expect(findSnapshotRange(rows, 10n).entryAccountId).toBe("a");
    expect(findSnapshotRange(rows, 11n).entryAccountId).toBe("b");
    expect(findSnapshotRange(rows, 100n).entryAccountId).toBe("c");
  });

  it("produces deterministic unique candidates from a 256-bit seed", () => {
    const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const first = selectCandidates(rows, 3, seed);
    const second = selectCandidates(rows, 3, seed);
    expect(first).toEqual(second);
    expect(new Set(first.map((candidate) => candidate.entryAccountId)).size).toBe(3);
    for (const candidate of first) {
      expect(candidate.selectedEntry >= candidate.rangeStart).toBe(true);
      expect(candidate.selectedEntry <= candidate.rangeEnd).toBe(true);
    }
  });

  it("uses rejection sampling inside the requested range", () => {
    const stream = new HmacCounterStream(new Uint8Array(32).fill(7));
    for (let index = 0; index < 100; index++) {
      const value = uniformBigInt(17n, (length) => stream.nextBytes(length));
      expect(value >= 0n && value < 17n).toBe(true);
    }
  });

  it("rejects gaps in sealed ranges", () => {
    expect(() => selectCandidates([
      { entryAccountId: "a", rangeStart: 1n, rangeEnd: 10n },
      { entryAccountId: "b", rangeStart: 12n, rangeEnd: 20n },
    ], 2, new Uint8Array(32).fill(1))).toThrow(/contiguous/);
  });
});
