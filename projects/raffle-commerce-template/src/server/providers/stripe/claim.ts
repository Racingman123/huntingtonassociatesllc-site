import { StripeBoundaryError } from "./errors";

export type WebhookDeliveryStatus = "RECEIVED" | "PROCESSING" | "PROCESSED" | "FAILED";

export type WebhookDeliveryRecord = {
  id: string;
  tenantId: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  payloadHash: string;
  status: string;
  attempts: number;
  lastError: string | null;
  receivedAt: Date;
  processedAt: Date | null;
};

export type InsertWebhookDeliveryInput = {
  tenantId: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  payloadHash: string;
  receivedAt: Date;
};

export interface WebhookDeliveryRepository {
  insertIfAbsent(input: InsertWebhookDeliveryInput): Promise<{
    inserted: boolean;
    record: WebhookDeliveryRecord;
  }>;
  findById(id: string): Promise<WebhookDeliveryRecord | null>;
  compareAndSwapClaim(input: {
    id: string;
    expectedStatus: string;
    expectedAttempts: number;
    claimedAt: Date;
  }): Promise<boolean>;
  markProcessed(id: string, processedAt: Date): Promise<boolean>;
  markFailed(id: string, message: string): Promise<boolean>;
}

export type WebhookClaim =
  | { status: "CLAIMED"; recordId: string; attempt: number }
  | { status: "DUPLICATE"; recordId: string; attempt: number }
  | { status: "IN_PROGRESS"; recordId: string; attempt: number };

const DEFAULT_CLAIM_LEASE_MS = 5 * 60 * 1000;

function assertSameDelivery(record: WebhookDeliveryRecord, input: InsertWebhookDeliveryInput) {
  if (record.eventType !== input.eventType || record.payloadHash !== input.payloadHash) {
    throw new StripeBoundaryError(
      "PAYLOAD_CONFLICT",
      "A provider event id was reused with different immutable content",
      { httpStatus: 409 },
    );
  }
}

/**
 * Atomically claims a provider delivery. FAILED records and abandoned PROCESSING
 * records can be retried, while an immutable event id with changed content is
 * rejected. The repository performs the final compare-and-swap.
 */
export async function claimWebhookDelivery(
  repository: WebhookDeliveryRepository,
  input: InsertWebhookDeliveryInput,
  options: { now?: Date; leaseMs?: number } = {},
): Promise<WebhookClaim> {
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? DEFAULT_CLAIM_LEASE_MS;
  let current = await repository.insertIfAbsent(input);

  for (let contention = 0; contention < 4; contention += 1) {
    const record = current.record;
    assertSameDelivery(record, input);

    if (current.inserted) {
      return { status: "CLAIMED", recordId: record.id, attempt: record.attempts };
    }
    if (record.status === "PROCESSED") {
      return { status: "DUPLICATE", recordId: record.id, attempt: record.attempts };
    }

    const leaseIsFresh = record.status === "PROCESSING"
      && now.getTime() - record.receivedAt.getTime() < leaseMs;
    if (leaseIsFresh) {
      return { status: "IN_PROGRESS", recordId: record.id, attempt: record.attempts };
    }
    if (!["RECEIVED", "FAILED", "PROCESSING"].includes(record.status)) {
      throw new StripeBoundaryError(
        "PAYLOAD_CONFLICT",
        `Webhook delivery is in unsupported state ${record.status}`,
        { httpStatus: 409 },
      );
    }

    const claimed = await repository.compareAndSwapClaim({
      id: record.id,
      expectedStatus: record.status,
      expectedAttempts: record.attempts,
      claimedAt: now,
    });
    if (claimed) {
      return { status: "CLAIMED", recordId: record.id, attempt: record.attempts + 1 };
    }

    const refreshed = await repository.findById(record.id);
    if (!refreshed) {
      throw new StripeBoundaryError(
        "PROCESSING_FAILED",
        "Webhook delivery disappeared during claim",
        { httpStatus: 500, retryable: true },
      );
    }
    current = { inserted: false, record: refreshed };
  }

  throw new StripeBoundaryError(
    "DELIVERY_IN_PROGRESS",
    "Webhook delivery claim is contended",
    { httpStatus: 409, retryable: true },
  );
}

