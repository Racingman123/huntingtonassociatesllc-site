import { describe, expect, it } from "vitest";
import {
  claimWebhookDelivery,
  type InsertWebhookDeliveryInput,
  type WebhookDeliveryRecord,
  type WebhookDeliveryRepository,
} from "./claim";

class MemoryRepository implements WebhookDeliveryRepository {
  records = new Map<string, WebhookDeliveryRecord>();
  serial = 0;

  key(input: Pick<InsertWebhookDeliveryInput, "tenantId" | "provider" | "providerEventId">) {
    return `${input.tenantId}:${input.provider}:${input.providerEventId}`;
  }

  async insertIfAbsent(input: InsertWebhookDeliveryInput) {
    const key = this.key(input);
    const existing = this.records.get(key);
    if (existing) return { inserted: false, record: { ...existing } };
    const record: WebhookDeliveryRecord = {
      id: `delivery-${this.serial += 1}`,
      ...input,
      status: "PROCESSING",
      attempts: 1,
      lastError: null,
      processedAt: null,
    };
    this.records.set(key, record);
    return { inserted: true, record: { ...record } };
  }

  async findById(id: string) {
    const record = [...this.records.values()].find((candidate) => candidate.id === id);
    return record ? { ...record } : null;
  }

  async compareAndSwapClaim(input: {
    id: string;
    expectedStatus: string;
    expectedAttempts: number;
    claimedAt: Date;
  }) {
    const record = [...this.records.values()].find((candidate) => candidate.id === input.id);
    if (!record || record.status !== input.expectedStatus || record.attempts !== input.expectedAttempts) {
      return false;
    }
    record.status = "PROCESSING";
    record.attempts += 1;
    record.receivedAt = input.claimedAt;
    record.processedAt = null;
    record.lastError = null;
    return true;
  }

  async markProcessed(id: string, processedAt: Date) {
    const record = [...this.records.values()].find((candidate) => candidate.id === id);
    if (!record || record.status !== "PROCESSING") return false;
    record.status = "PROCESSED";
    record.processedAt = processedAt;
    record.lastError = null;
    return true;
  }

  async markFailed(id: string, message: string) {
    const record = [...this.records.values()].find((candidate) => candidate.id === id);
    if (!record || record.status !== "PROCESSING") return false;
    record.status = "FAILED";
    record.lastError = message;
    record.processedAt = null;
    return true;
  }
}

const receivedAt = new Date("2026-07-12T12:00:00.000Z");
const input: InsertWebhookDeliveryInput = {
  tenantId: "tenant-1",
  provider: "STRIPE",
  providerEventId: "evt_123",
  eventType: "invoice.paid",
  payloadHash: "a".repeat(64),
  receivedAt,
};

describe("Stripe webhook delivery claims", () => {
  it("claims the first delivery and recognizes a processed redelivery", async () => {
    const repository = new MemoryRepository();
    const first = await claimWebhookDelivery(repository, input, { now: receivedAt });
    expect(first).toMatchObject({ status: "CLAIMED", attempt: 1 });
    await repository.markProcessed(first.recordId, new Date("2026-07-12T12:00:02.000Z"));

    const duplicate = await claimWebhookDelivery(repository, input, {
      now: new Date("2026-07-12T12:01:00.000Z"),
    });
    expect(duplicate).toMatchObject({ status: "DUPLICATE", attempt: 1 });
  });

  it("does not let a simultaneous delivery steal a live processing lease", async () => {
    const repository = new MemoryRepository();
    await claimWebhookDelivery(repository, input, { now: receivedAt });
    const concurrent = await claimWebhookDelivery(repository, input, {
      now: new Date("2026-07-12T12:00:30.000Z"),
      leaseMs: 60_000,
    });
    expect(concurrent).toMatchObject({ status: "IN_PROGRESS", attempt: 1 });
  });

  it("reclaims failed and expired processing attempts with compare-and-swap", async () => {
    const repository = new MemoryRepository();
    const first = await claimWebhookDelivery(repository, input, { now: receivedAt });
    await repository.markFailed(first.recordId, "temporary failure");
    const retry = await claimWebhookDelivery(repository, input, {
      now: new Date("2026-07-12T12:01:00.000Z"),
    });
    expect(retry).toMatchObject({ status: "CLAIMED", attempt: 2 });

    const staleRetry = await claimWebhookDelivery(repository, input, {
      now: new Date("2026-07-12T12:10:00.000Z"),
      leaseMs: 60_000,
    });
    expect(staleRetry).toMatchObject({ status: "CLAIMED", attempt: 3 });
  });

  it("rejects an immutable Stripe event id reused with another payload", async () => {
    const repository = new MemoryRepository();
    await claimWebhookDelivery(repository, input, { now: receivedAt });
    await expect(claimWebhookDelivery(repository, {
      ...input,
      payloadHash: "b".repeat(64),
    }, { now: new Date("2026-07-12T12:00:05.000Z") })).rejects.toMatchObject({
      code: "PAYLOAD_CONFLICT",
    });
  });
});

