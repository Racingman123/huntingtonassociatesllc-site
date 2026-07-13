import "server-only";

import { db } from "@/server/db";
import type {
  InsertWebhookDeliveryInput,
  WebhookDeliveryRecord,
  WebhookDeliveryRepository,
} from "./claim";

function isUniqueConstraintError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function asRecord(record: WebhookDeliveryRecord) {
  return record;
}

export const prismaWebhookDeliveryRepository: WebhookDeliveryRepository = {
  async insertIfAbsent(input: InsertWebhookDeliveryInput) {
    try {
      const record = await db.webhookEvent.create({
        data: {
          tenantId: input.tenantId,
          provider: input.provider,
          providerEventId: input.providerEventId,
          eventType: input.eventType,
          payloadHash: input.payloadHash,
          status: "PROCESSING",
          attempts: 1,
          receivedAt: input.receivedAt,
        },
      });
      return { inserted: true, record: asRecord(record) };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const record = await db.webhookEvent.findUnique({
        where: {
          tenantId_provider_providerEventId: {
            tenantId: input.tenantId,
            provider: input.provider,
            providerEventId: input.providerEventId,
          },
        },
      });
      if (!record) throw error;
      return { inserted: false, record: asRecord(record) };
    }
  },

  async findById(id) {
    return db.webhookEvent.findUnique({ where: { id } });
  },

  async compareAndSwapClaim(input) {
    const result = await db.webhookEvent.updateMany({
      where: {
        id: input.id,
        status: input.expectedStatus,
        attempts: input.expectedAttempts,
      },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        lastError: null,
        processedAt: null,
        // This is the latest delivery/claim time and supplies the retry lease.
        receivedAt: input.claimedAt,
      },
    });
    return result.count === 1;
  },

  async markProcessed(id, processedAt) {
    const result = await db.webhookEvent.updateMany({
      where: { id, status: "PROCESSING" },
      data: { status: "PROCESSED", processedAt, lastError: null },
    });
    return result.count === 1;
  },

  async markFailed(id, message) {
    const result = await db.webhookEvent.updateMany({
      where: { id, status: "PROCESSING" },
      data: {
        status: "FAILED",
        lastError: message.slice(0, 2_000),
        processedAt: null,
      },
    });
    return result.count === 1;
  },
};

