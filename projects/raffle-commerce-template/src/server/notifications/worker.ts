import "server-only";

import { db } from "@/server/db";
import {
  asNotificationDeliveryError,
  type EmailNotificationProvider,
} from "./email";
import { createResendEmailProvider } from "./resend";
import { buildTransactionalEmail, EMAIL_OUTBOX_KINDS } from "./templates";

export const MAX_EMAIL_DELIVERY_ATTEMPTS = 5;
const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 25;
const LEASE_MS = 2 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

export type EmailOutboxBatchResult = {
  scanned: number;
  claimed: number;
  accepted: number;
  skipped: number;
  retried: number;
  deadLettered: number;
  claimConflicts: number;
};

export function emailRetryDelayMs(attempt: number) {
  const normalizedAttempt = Math.max(1, Math.min(MAX_EMAIL_DELIVERY_ATTEMPTS, attempt));
  return Math.min(MAX_BACKOFF_MS, 60_000 * (2 ** (normalizedAttempt - 1)));
}

function safeFailureCode(error: unknown) {
  const deliveryError = asNotificationDeliveryError(error);
  const code = /^[a-z0-9_]{1,120}$/i.test(deliveryError.code)
    ? deliveryError.code.toLowerCase()
    : "notification_processing_failed";
  return { code, retryable: deliveryError.retryable };
}

export async function processEmailOutboxBatch(options: {
  now?: Date;
  limit?: number;
  provider?: EmailNotificationProvider;
} = {}): Promise<EmailOutboxBatchResult> {
  const now = options.now ?? new Date();
  const requestedLimit = options.limit ?? DEFAULT_BATCH_SIZE;
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(MAX_BATCH_SIZE, requestedLimit))
    : DEFAULT_BATCH_SIZE;
  const provider = options.provider ?? createResendEmailProvider();
  const candidates = await db.outboxEvent.findMany({
    where: {
      kind: { in: [...EMAIL_OUTBOX_KINDS] },
      status: { in: ["PENDING", "FAILED", "PROCESSING"] },
      nextAttemptAt: { lte: now },
    },
    select: {
      id: true,
      tenantId: true,
      aggregateType: true,
      aggregateId: true,
      kind: true,
      status: true,
      attempts: true,
      nextAttemptAt: true,
    },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: limit,
  });
  const result: EmailOutboxBatchResult = {
    scanned: candidates.length,
    claimed: 0,
    accepted: 0,
    skipped: 0,
    retried: 0,
    deadLettered: 0,
    claimConflicts: 0,
  };

  for (const event of candidates) {
    if (event.attempts >= MAX_EMAIL_DELIVERY_ATTEMPTS) {
      const exhausted = await db.outboxEvent.updateMany({
        where: {
          id: event.id,
          tenantId: event.tenantId,
          kind: event.kind,
          status: event.status,
          attempts: event.attempts,
          nextAttemptAt: event.nextAttemptAt,
        },
        data: {
          status: "DEAD_LETTER",
          processedAt: null,
          lastError: "email_delivery_attempts_exhausted",
        },
      });
      if (exhausted.count === 1) result.deadLettered += 1;
      else result.claimConflicts += 1;
      continue;
    }
    const attempt = event.attempts + 1;
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    const claimed = await db.outboxEvent.updateMany({
      where: {
        id: event.id,
        tenantId: event.tenantId,
        kind: event.kind,
        status: event.status,
        attempts: event.attempts,
        nextAttemptAt: event.nextAttemptAt,
      },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        nextAttemptAt: leaseUntil,
        processedAt: null,
        lastError: null,
      },
    });
    if (claimed.count !== 1) {
      result.claimConflicts += 1;
      continue;
    }
    result.claimed += 1;

    try {
      const email = await buildTransactionalEmail(event);
      if (email) {
        await provider.send(email, `outbox/${event.id}/${email.templateVersion}`);
      }
      const completed = await db.outboxEvent.updateMany({
        where: {
          id: event.id,
          tenantId: event.tenantId,
          status: "PROCESSING",
          attempts: attempt,
          nextAttemptAt: leaseUntil,
        },
        data: {
          status: "PROCESSED",
          processedAt: now,
          lastError: null,
        },
      });
      if (completed.count === 1) {
        if (email) result.accepted += 1;
        else result.skipped += 1;
      }
      else result.claimConflicts += 1;
    } catch (error) {
      const failure = safeFailureCode(error);
      const deadLetter = !failure.retryable || attempt >= MAX_EMAIL_DELIVERY_ATTEMPTS;
      const nextAttemptAt = deadLetter
        ? now
        : new Date(now.getTime() + emailRetryDelayMs(attempt));
      const failed = await db.outboxEvent.updateMany({
        where: {
          id: event.id,
          tenantId: event.tenantId,
          status: "PROCESSING",
          attempts: attempt,
          nextAttemptAt: leaseUntil,
        },
        data: {
          status: deadLetter ? "DEAD_LETTER" : "FAILED",
          nextAttemptAt,
          processedAt: null,
          lastError: failure.code,
        },
      });
      if (failed.count !== 1) result.claimConflicts += 1;
      else if (deadLetter) result.deadLettered += 1;
      else result.retried += 1;
    }
  }

  return result;
}
