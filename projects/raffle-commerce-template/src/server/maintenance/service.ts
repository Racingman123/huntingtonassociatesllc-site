import "server-only";

import { db } from "@/server/db";
import { activateScheduledCampaigns, type CampaignActivationResult } from "@/server/campaigns/scheduler";
import { releaseExpiredStripeCheckoutOrders } from "@/server/commerce/stripe-checkout";
import { isResendConfigured } from "@/server/notifications/resend";
import { processEmailOutboxBatch, type EmailOutboxBatchResult } from "@/server/notifications/worker";
import { finalizeSubscriptionCancellation } from "@/server/subscriptions/service";

const BATCH_SIZE = 100;
const RATE_LIMIT_PRUNE_BATCH_SIZE = 1_000;
const RATE_LIMIT_RETENTION_MS = 48 * 60 * 60 * 1_000;

export type MaintenanceResult = {
  ranAt: string;
  campaignsClosed: number;
  campaignActivation: CampaignActivationResult;
  cancellationsFinalized: number;
  cancellationFailures: number;
  sessionsRevoked: number;
  pendingOutbox: number;
  pendingAmoe: number;
  rateLimitBucketsPruned: number;
  accountChallengesPruned: number;
  stripeCheckoutCleanup: {
    scanned: number;
    released: number;
    skipped: number;
    failures: number;
  };
  emailDelivery: EmailOutboxBatchResult & { configured: boolean };
};

/**
 * Bounded, idempotent maintenance pass. Transactional email delivery is a
 * deliberately small batch and remains disabled until a provider is configured.
 * Non-email outbox kinds still belong to their provider-specific workers.
 */
export async function runMaintenance(now = new Date()): Promise<MaintenanceResult> {
  const dueCampaigns = await db.campaign.findMany({
    where: { status: "LIVE", endsAt: { lte: now } },
    select: { id: true, tenantId: true, code: true, endsAt: true },
    orderBy: { endsAt: "asc" },
    take: BATCH_SIZE,
  });
  let campaignsClosed = 0;
  for (const campaign of dueCampaigns) {
    const didClose = await db.$transaction(async (tx) => {
      const closed = await tx.campaign.updateMany({
        where: { id: campaign.id, tenantId: campaign.tenantId, status: "LIVE", endsAt: { lte: now } },
        data: { status: "ENTRY_CLOSED" },
      });
      if (closed.count !== 1) return false;
      await tx.auditEvent.create({
        data: {
          tenantId: campaign.tenantId,
          actorType: "SYSTEM",
          actorId: "maintenance-worker",
          action: "CAMPAIGN_ENTRY_CLOSED",
          resourceType: "Campaign",
          resourceId: campaign.id,
          metadataJson: JSON.stringify({ code: campaign.code, endedAt: campaign.endsAt.toISOString() }),
        },
      });
      return true;
    });
    if (didClose) campaignsClosed += 1;
  }
  // Close an ended LIVE campaign before considering the next scheduled one for
  // the same tenant. The activation service still serializes and fails closed
  // if any overlapping LIVE promotion remains.
  const campaignActivation = await activateScheduledCampaigns(now, BATCH_SIZE);

  const dueCancellations = await db.subscription.findMany({
    where: {
      status: { in: ["ACTIVE", "PAST_DUE"] },
      cancelAtPeriodEnd: true,
      currentPeriodEndsAt: { lte: now },
    },
    select: { id: true, tenantId: true },
    orderBy: { currentPeriodEndsAt: "asc" },
    take: BATCH_SIZE,
  });
  let cancellationsFinalized = 0;
  let cancellationFailures = 0;
  for (const subscription of dueCancellations) {
    try {
      const result = await finalizeSubscriptionCancellation({
        tenantId: subscription.tenantId,
        subscriptionId: subscription.id,
      });
      if (result.finalized) cancellationsFinalized += 1;
    } catch {
      cancellationFailures += 1;
    }
  }

  const expired = await db.session.updateMany({
    where: { expiresAt: { lte: now }, revokedAt: null },
    data: { revokedAt: now },
  });
  const rateLimitCutoff = new Date(now.getTime() - RATE_LIMIT_RETENTION_MS);
  const expiredRateLimitBuckets = await db.rateLimitBucket.findMany({
    where: { windowStart: { lt: rateLimitCutoff } },
    select: { id: true },
    orderBy: [{ windowStart: "asc" }, { id: "asc" }],
    take: RATE_LIMIT_PRUNE_BATCH_SIZE,
  });
  const prunedRateLimitBuckets = expiredRateLimitBuckets.length
    ? await db.rateLimitBucket.deleteMany({
        where: { id: { in: expiredRateLimitBuckets.map((bucket) => bucket.id) } },
      })
    : { count: 0 };
  const expiredChallenges = await db.accountChallenge.findMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1_000) } },
        { consumedAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1_000) } },
      ],
    },
    select: { id: true },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: BATCH_SIZE,
  });
  const prunedChallenges = expiredChallenges.length
    ? await db.$transaction(async (tx) => {
        const ids = expiredChallenges.map((item) => item.id);
        await tx.outboxEvent.updateMany({
          where: {
            aggregateType: "AccountChallenge",
            aggregateId: { in: ids },
            kind: { in: ["ACCOUNT_EMAIL_VERIFICATION", "ACCOUNT_PASSWORD_RECOVERY"] },
            status: { in: ["PENDING", "FAILED", "PROCESSING"] },
          },
          data: { status: "PROCESSED", processedAt: now, lastError: null },
        });
        return tx.accountChallenge.deleteMany({ where: { id: { in: ids } } });
      })
    : { count: 0 };
  const emailConfigured = isResendConfigured();
  const stripeCheckoutCleanup = process.env.DEMO_MODE === "true"
    ? { scanned: 0, released: 0, skipped: 0, failures: 0 }
    : await releaseExpiredStripeCheckoutOrders(now, BATCH_SIZE);
  const emailDelivery = emailConfigured
    ? await processEmailOutboxBatch({ now, limit: 3 })
    : { scanned: 0, claimed: 0, accepted: 0, skipped: 0, retried: 0, deadLettered: 0, claimConflicts: 0 };
  const [pendingOutbox, pendingAmoe] = await Promise.all([
    db.outboxEvent.count({ where: { status: { in: ["PENDING", "FAILED", "PROCESSING"] } } }),
    db.freeEntrySubmission.count({ where: { status: { in: ["PENDING", "REVIEW"] } } }),
  ]);

  return {
    ranAt: now.toISOString(),
    campaignsClosed,
    campaignActivation,
    cancellationsFinalized,
    cancellationFailures,
    sessionsRevoked: expired.count,
    pendingOutbox,
    pendingAmoe,
    rateLimitBucketsPruned: prunedRateLimitBuckets.count,
    accountChallengesPruned: prunedChallenges.count,
    stripeCheckoutCleanup,
    emailDelivery: { configured: emailConfigured, ...emailDelivery },
  };
}
