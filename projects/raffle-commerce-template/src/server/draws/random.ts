import { createHmac } from "node:crypto";

export type SnapshotRange = {
  entryAccountId: string;
  rangeStart: bigint;
  rangeEnd: bigint;
};

export type SelectedCandidate = SnapshotRange & { selectedEntry: bigint };

export class HmacCounterStream {
  private counter = 0n;

  constructor(private readonly seed: Uint8Array) {
    if (seed.byteLength < 32) throw new Error("Draw seed must contain at least 256 bits");
  }

  nextBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 1) throw new Error("length must be positive");
    const chunks: Buffer[] = [];
    let collected = 0;
    while (collected < length) {
      const counterBytes = Buffer.alloc(8);
      counterBytes.writeBigUInt64BE(this.counter++);
      const chunk = createHmac("sha256", this.seed).update("giveaway-draw-v1").update(counterBytes).digest();
      chunks.push(chunk);
      collected += chunk.length;
    }
    return Buffer.concat(chunks).subarray(0, length);
  }
}

function bytesToBigInt(bytes: Uint8Array) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

export function uniformBigInt(maxExclusive: bigint, nextBytes: (length: number) => Uint8Array): bigint {
  if (maxExclusive <= 0n) throw new Error("maxExclusive must be positive");
  const bitLength = maxExclusive.toString(2).length;
  const byteLength = Math.ceil(bitLength / 8);
  const extraBits = byteLength * 8 - bitLength;
  const mask = 0xff >>> extraBits;
  for (;;) {
    const bytes = Uint8Array.from(nextBytes(byteLength));
    bytes[0] &= mask;
    const candidate = bytesToBigInt(bytes);
    if (candidate < maxExclusive) return candidate;
  }
}

export function findSnapshotRange(rows: SnapshotRange[], selectedEntry: bigint): SnapshotRange {
  let low = 0;
  let high = rows.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const row = rows[middle];
    if (selectedEntry < row.rangeStart) high = middle - 1;
    else if (selectedEntry > row.rangeEnd) low = middle + 1;
    else return row;
  }
  throw new Error("Selected entry is outside the snapshot ranges");
}

export function selectCandidates(rows: SnapshotRange[], count: number, seed: Uint8Array): SelectedCandidate[] {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("count must be positive");
  if (rows.length < count) throw new Error("Snapshot has fewer entrants than requested candidates");
  const ordered = [...rows].sort((a, b) => a.rangeStart < b.rangeStart ? -1 : a.rangeStart > b.rangeStart ? 1 : 0);
  const totalEntries = ordered.at(-1)?.rangeEnd ?? 0n;
  if (ordered[0]?.rangeStart !== 1n || totalEntries <= 0n) throw new Error("Snapshot ranges are not valid");
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index].rangeStart !== ordered[index - 1].rangeEnd + 1n) throw new Error("Snapshot ranges must be contiguous");
  }
  const stream = new HmacCounterStream(seed);
  const selectedAccounts = new Set<string>();
  const selected: SelectedCandidate[] = [];
  const maxAttempts = Math.max(100, count * 1000);
  for (let attempts = 0; selected.length < count && attempts < maxAttempts; attempts++) {
    const entryNumber = uniformBigInt(totalEntries, (length) => stream.nextBytes(length)) + 1n;
    const row = findSnapshotRange(ordered, entryNumber);
    if (selectedAccounts.has(row.entryAccountId)) continue;
    selectedAccounts.add(row.entryAccountId);
    selected.push({ ...row, selectedEntry: entryNumber });
  }
  if (selected.length !== count) throw new Error("Unable to select the requested number of unique entrants");
  return selected;
}
