import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/server/db";
import { resolveConfiguredCampaignMultiplier } from "@/server/commerce/multiplier";
import { evaluateCampaignLocationEligibility } from "@/server/campaigns/eligibility";
import { assertCampaignOfficialRules } from "@/lib/official-rules";
import {
  inspectCampaignReleaseIntegrity,
} from "@/server/campaigns/integrity";
import {
  getStripeHostedSubscriptionBoundary,
  type StripeHostedSubscriptionBoundary,
} from "@/server/providers/stripe/hosted-subscription";
import {
  createStripeSubscriptionFingerprint,
  type PreparedStripeSubscriptionRequest,
  type StripeSubscriptionFingerprintFacts,
} from "@/server/providers/stripe/subscription-contract";
import {
  billingIntervals,
  calculatePeriodEnd,
  calculateRenewal,
  selectMembershipEntryBand,
  type BillingInterval,
  type MembershipBand,
} from "./calculation";

const CHECKOUT_TTL_MS = 35 * 60 * 1000;
const databaseId = z.string().trim().min(1).max(191);
const providerId = z.string().trim().min(1).max(255);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.union([z.date(), z.string().trim().min(1).pipe(z.coerce.date())]);
const MAX_SETTLEMENT_ATTEMPTS = 5;

class MembershipEntryClaimConflict extends Error {
  constructor() {
    super("Membership invoice settlement lost its entry-cap reservation claim");
    this.name = "MembershipEntryClaimConflict";
  }
}

function prismaErrorCode(error: unknown) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function isRetryableSettlementConflict(error: unknown) {
  return error instanceof MembershipEntryClaimConflict
    || ["P1008", "P2002", "P2034"].includes(prismaErrorCode(error) ?? "");
}

export const startStripeSubscriptionSchema = z.object({
  tenantId: databaseId,
  planId: databaseId,
  entrantId: databaseId,
  userId: databaseId,
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

export const acceptMembershipCampaignRulesSchema = z.object({
  tenantId: databaseId,
  campaignId: databaseId,
  entrantId: databaseId,
  userId: databaseId,
}).strict();

export const bindStripeSubscriptionEnrollmentSchema = z.object({
  tenantId: databaseId,
  subscriptionId: databaseId,
  subscriptionFingerprint: sha256Hex,
  providerCheckoutId: providerId,
  providerSubscriptionId: providerId,
  providerCustomerId: providerId,
  providerPriceId: providerId,
  providerEventId: providerId,
  occurredAt: instant,
}).strict();

export const expireStripeSubscriptionEnrollmentSchema = z.object({
  tenantId: databaseId,
  subscriptionId: databaseId,
  subscriptionFingerprint: sha256Hex,
  providerCheckoutId: providerId,
  providerPriceId: providerId,
  providerEventId: providerId,
  occurredAt: instant,
}).strict();

export const settleStripeSubscriptionInvoiceSchema = z.object({
  tenantId: databaseId,
  subscriptionId: databaseId,
  subscriptionFingerprint: sha256Hex,
  providerSubscriptionId: providerId,
  providerCustomerId: providerId,
  providerInvoiceId: providerId,
  providerPaymentId: providerId,
  providerEventId: providerId,
  providerPriceId: providerId,
  billingReason: z.enum(["subscription_create", "subscription_cycle"]),
  capturedAmountCents: z.number().int().positive().safe(),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  periodStartsAt: instant,
  periodEndsAt: instant,
  occurredAt: instant,
  payloadHash: sha256Hex,
  idempotencyKey: z.string().trim().min(8).max(255),
}).strict();

export const failStripeSubscriptionInvoiceSchema = z.object({
  tenantId: databaseId,
  subscriptionId: databaseId,
  subscriptionFingerprint: sha256Hex,
  providerSubscriptionId: providerId,
  providerCustomerId: providerId,
  providerPriceId: providerId,
  providerInvoiceId: providerId,
  providerEventId: providerId,
  occurredAt: instant,
}).strict();

export const applyStripeSubscriptionStateSchema = z.object({
  tenantId: databaseId,
  subscriptionId: databaseId,
  subscriptionFingerprint: sha256Hex,
  providerSubscriptionId: providerId,
  providerCustomerId: providerId,
  providerPriceId: providerId,
  priceCents: z.number().int().positive().safe(),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  billingInterval: z.enum(["DAY", "WEEK", "MONTH", "YEAR"]),
  billingIntervalCount: z.number().int().positive().safe(),
  providerEventId: providerId,
  providerStatus: z.enum([
    "incomplete",
    "incomplete_expired",
    "trialing",
    "active",
    "past_due",
    "canceled",
    "unpaid",
    "paused",
  ]),
  cancelAtPeriodEnd: z.boolean(),
  periodStartsAt: instant,
  periodEndsAt: instant,
  endedAt: instant.nullable(),
  occurredAt: instant,
}).strict();

export type StripeSubscriptionSettlementReceipt = {
  subscriptionId: string;
  cycleId: string;
  cycleNumber: number;
  orderId: string;
  orderNumber: string;
  paymentId: string;
  campaignId: string | null;
  entries: bigint;
  periodStartsAt: Date;
  periodEndsAt: Date;
  settledAt: Date;
  idempotent: boolean;
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function parseBillingInterval(value: string): BillingInterval {
  const normalized = value.toUpperCase();
  if (!billingIntervals.includes(normalized as BillingInterval)) {
    throw new Error(`Unsupported subscription interval: ${value}`);
  }
  return normalized as BillingInterval;
}

function canonicalAppUrl() {
  const configured = process.env.APP_URL?.trim();
  if (!configured) throw new Error("APP_URL must be configured before hosted membership checkout");
  const url = new URL(configured);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("APP_URL must use HTTPS in production");
  }
  if (!url.origin || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("APP_URL must be an absolute HTTP(S) origin");
  }
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("APP_URL must contain only the canonical application origin");
  }
  return url;
}

type StripeSubscriptionSnapshot = {
  id: string;
  tenantId: string;
  planId: string;
  userId: string | null;
  entrantId: string;
  providerPriceId: string | null;
  priceCents: number | null;
  currency: string | null;
  billingInterval: string | null;
  billingIntervalCount: number | null;
  enrollmentIdempotencyKey: string | null;
  enrollmentFingerprint: string | null;
  checkoutExpiresAt: Date | null;
};

function fingerprintFacts(subscription: StripeSubscriptionSnapshot): StripeSubscriptionFingerprintFacts {
  if (
    !subscription.userId
    || !subscription.providerPriceId
    || subscription.priceCents == null
    || !subscription.currency
    || !subscription.billingInterval
    || subscription.billingIntervalCount == null
    || !subscription.enrollmentIdempotencyKey
    || !subscription.checkoutExpiresAt
  ) {
    throw new Error("Stripe subscription is missing its immutable enrollment snapshot");
  }
  return {
    tenantId: subscription.tenantId,
    subscriptionId: subscription.id,
    planId: subscription.planId,
    userId: subscription.userId,
    entrantId: subscription.entrantId,
    providerPriceId: subscription.providerPriceId,
    priceCents: subscription.priceCents,
    currency: subscription.currency,
    billingInterval: subscription.billingInterval,
    billingIntervalCount: subscription.billingIntervalCount,
    enrollmentIdempotencyKey: subscription.enrollmentIdempotencyKey,
    checkoutExpiresAt: subscription.checkoutExpiresAt.toISOString(),
  };
}

function assertEnrollmentFingerprint(subscription: StripeSubscriptionSnapshot) {
  const fingerprint = createStripeSubscriptionFingerprint(fingerprintFacts(subscription));
  if (!subscription.enrollmentFingerprint || subscription.enrollmentFingerprint !== fingerprint) {
    throw new Error("Stripe subscription enrollment fingerprint does not match persisted facts");
  }
  return fingerprint;
}

function requestFromSubscription(
  subscription: StripeSubscriptionSnapshot & { user: { email: string } | null },
): PreparedStripeSubscriptionRequest {
  if (!subscription.user) throw new Error("Stripe subscription user is unavailable");
  const facts = fingerprintFacts(subscription);
  const subscriptionFingerprint = assertEnrollmentFingerprint(subscription);
  const appUrl = canonicalAppUrl();
  const successUrl = new URL("/account/membership", appUrl);
  successUrl.searchParams.set("checkout", "processing");
  const cancelUrl = new URL("/membership", appUrl);
  cancelUrl.searchParams.set("checkout", "cancelled");
  return {
    ...facts,
    subscriptionFingerprint,
    customerEmail: subscription.user.email,
    successUrl: successUrl.toString(),
    cancelUrl: cancelUrl.toString(),
    providerIdempotencyKey: `stripe-membership:${sha256(`${subscription.tenantId}:${subscription.id}:${subscriptionFingerprint}`)}`,
  };
}

function enrollmentLockKey(tenantId: string, planId: string, userId: string) {
  return `stripe-membership:${sha256(`${tenantId}:${planId}:${userId}`)}`;
}

/** Records an explicit acceptance of the exact immutable campaign rules. */
export async function acceptMembershipCampaignRules(rawInput: unknown) {
  const input = acceptMembershipCampaignRulesSchema.parse(rawInput);
  const now = new Date();
  return db.$transaction(async (tx) => {
    const [campaign, entrant] = await Promise.all([
      tx.campaign.findFirst({
        where: {
          id: input.campaignId,
          tenantId: input.tenantId,
          status: "LIVE",
          startsAt: { lte: now },
          endsAt: { gt: now },
        },
        include: { officialRulesDocument: true },
      }),
      tx.entrant.findFirst({
        where: {
          id: input.entrantId,
          tenantId: input.tenantId,
          userId: input.userId,
          user: { status: "ACTIVE", emailVerifiedAt: { not: null } },
        },
      }),
    ]);
    if (!campaign || !entrant) throw new Error("Membership campaign acceptance is unavailable");
    const integrity = await inspectCampaignReleaseIntegrity(tx, campaign.id);
    if (!integrity.valid) throw new Error("Campaign release integrity verification failed");
    const rules = assertCampaignOfficialRules(campaign);
    const acceptance = await tx.rulesAcceptance.upsert({
      where: {
        campaignId_entrantId_legalDocumentId_method: {
          campaignId: campaign.id,
          entrantId: entrant.id,
          legalDocumentId: rules.id,
          method: "MEMBERSHIP",
        },
      },
      update: {},
      create: {
        tenantId: input.tenantId,
        campaignId: campaign.id,
        entrantId: entrant.id,
        legalDocumentId: rules.id,
        documentChecksum: rules.checksum,
        method: "MEMBERSHIP",
      },
    });
    if (acceptance.documentChecksum !== rules.checksum) {
      throw new Error("Membership rules acceptance conflicts with the exact campaign release");
    }
    await tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: "USER",
        actorId: input.userId,
        action: "MEMBERSHIP_CAMPAIGN_RULES_ACCEPTED",
        resourceType: "RulesAcceptance",
        resourceId: acceptance.id,
        metadataJson: JSON.stringify({
          campaignId: campaign.id,
          legalDocumentId: rules.id,
          documentChecksum: rules.checksum,
        }),
      },
    });
    return acceptance;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function findEnrollment(tenantId: string, idempotencyKey: string) {
  return db.subscription.findUnique({
    where: {
      tenantId_enrollmentIdempotencyKey: { tenantId, enrollmentIdempotencyKey: idempotencyKey },
    },
    include: { user: { select: { email: true } } },
  });
}

function assertSameEnrollment(
  subscription: StripeSubscriptionSnapshot,
  input: z.infer<typeof startStripeSubscriptionSchema>,
) {
  if (
    subscription.planId !== input.planId
    || subscription.entrantId !== input.entrantId
    || subscription.userId !== input.userId
  ) {
    throw new Error("Membership idempotency key was already used for a different enrollment");
  }
  assertEnrollmentFingerprint(subscription);
}

export async function startStripeSubscriptionCheckout(
  rawInput: unknown,
  boundary: StripeHostedSubscriptionBoundary = getStripeHostedSubscriptionBoundary(),
) {
  const input = startStripeSubscriptionSchema.parse(rawInput);
  let subscription = await findEnrollment(input.tenantId, input.idempotencyKey);
  if (subscription) {
    assertSameEnrollment(subscription, input);
    if (["ACTIVE", "PAST_DUE"].includes(subscription.status) && subscription.settledCycleCount > 0) {
      return {
        subscriptionId: subscription.id,
        redirectUrl: new URL("/account/membership", canonicalAppUrl()).toString(),
        idempotent: true,
      };
    }
    if (subscription.status !== "PENDING") {
      throw new Error("This membership enrollment is no longer payable");
    }
    if (!subscription.checkoutExpiresAt || subscription.checkoutExpiresAt <= new Date()) {
      throw new Error("This membership enrollment has expired; refresh to start again");
    }
  } else {
    const subscriptionId = randomUUID();
    const now = new Date();
    const checkoutExpiresAt = new Date(now.getTime() + CHECKOUT_TTL_MS);
    subscription = await db.$transaction(async (tx) => {
      const [tenant, plan, entrant, user] = await Promise.all([
        tx.tenant.findUnique({ where: { id: input.tenantId } }),
        tx.subscriptionPlan.findFirst({
          where: { id: input.planId, tenantId: input.tenantId },
          include: { product: true },
        }),
        tx.entrant.findFirst({ where: { id: input.entrantId, tenantId: input.tenantId } }),
        tx.user.findFirst({ where: { id: input.userId, tenantId: input.tenantId } }),
      ]);
      if (!tenant || tenant.status !== "ACTIVE") throw new Error("Tenant is unavailable");
      if (!plan || plan.status !== "ACTIVE" || !plan.providerPriceId) {
        throw new Error("Membership plan is not configured for Stripe enrollment");
      }
      if (plan.product.status !== "ACTIVE" || plan.product.productType !== "MEMBERSHIP") {
        throw new Error("Membership plan is not attached to an active membership product");
      }
      if (!Number.isSafeInteger(plan.priceCents) || plan.priceCents <= 0 || plan.currency !== tenant.currency) {
        throw new Error("Membership plan price or currency is invalid");
      }
      const interval = parseBillingInterval(plan.interval);
      if (!Number.isSafeInteger(plan.intervalCount) || plan.intervalCount <= 0) {
        throw new Error("Membership billing interval is invalid");
      }
      if (!entrant || !user || user.status !== "ACTIVE" || entrant.userId !== user.id) {
        throw new Error("Membership entrant and active user are not linked in this tenant");
      }
      const lockKey = enrollmentLockKey(input.tenantId, plan.id, user.id);
      const duplicate = await tx.subscription.findFirst({
        where: {
          tenantId: input.tenantId,
          planId: plan.id,
          userId: user.id,
          status: { in: ["PENDING", "ACTIVE", "PAST_DUE"] },
        },
        select: { id: true },
      });
      if (duplicate) throw new Error("Account already has an active or pending subscription to this plan");
      const facts: StripeSubscriptionFingerprintFacts = {
        tenantId: input.tenantId,
        subscriptionId,
        planId: plan.id,
        userId: user.id,
        entrantId: entrant.id,
        providerPriceId: plan.providerPriceId,
        priceCents: plan.priceCents,
        currency: plan.currency,
        billingInterval: interval,
        billingIntervalCount: plan.intervalCount,
        enrollmentIdempotencyKey: input.idempotencyKey,
        checkoutExpiresAt: checkoutExpiresAt.toISOString(),
      };
      const enrollmentFingerprint = createStripeSubscriptionFingerprint(facts);
      const created = await tx.subscription.create({
        data: {
          id: subscriptionId,
          tenantId: input.tenantId,
          planId: plan.id,
          userId: user.id,
          entrantId: entrant.id,
          status: "PENDING",
          provider: "STRIPE",
          providerPriceId: plan.providerPriceId,
          enrollmentIdempotencyKey: input.idempotencyKey,
          enrollmentFingerprint,
          enrollmentLockKey: lockKey,
          checkoutExpiresAt,
          priceCents: plan.priceCents,
          currency: plan.currency,
          billingInterval: interval,
          billingIntervalCount: plan.intervalCount,
          continuousSince: now,
          currentPeriodStartsAt: now,
          currentPeriodEndsAt: calculatePeriodEnd(now, interval, plan.intervalCount),
        },
        include: { user: { select: { email: true } } },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: input.tenantId,
          actorType: "USER",
          actorId: user.id,
          action: "STRIPE_SUBSCRIPTION_PREPARED",
          resourceType: "Subscription",
          resourceId: created.id,
          metadataJson: JSON.stringify({ planId: plan.id, enrollmentFingerprint, checkoutExpiresAt }),
        },
      });
      return created;
    });
  }

  const request = requestFromSubscription(subscription);
  const hosted = await boundary.createEnrollment(request);
  const bound = await db.subscription.updateMany({
    where: {
      id: subscription.id,
      tenantId: subscription.tenantId,
      status: "PENDING",
      enrollmentFingerprint: request.subscriptionFingerprint,
      OR: [{ providerCheckoutId: null }, { providerCheckoutId: hosted.providerCheckoutId }],
    },
    data: { providerCheckoutId: hosted.providerCheckoutId },
  });
  if (bound.count !== 1) throw new Error("Stripe membership checkout conflicts with the prepared enrollment");
  return {
    subscriptionId: subscription.id,
    providerCheckoutId: hosted.providerCheckoutId,
    redirectUrl: hosted.redirectUrl,
    idempotent: Boolean(subscription.providerCheckoutId),
  };
}

function assertStripeIdentity(subscription: {
  provider: string;
  enrollmentFingerprint: string | null;
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
  providerPriceId: string | null;
}, input: {
  subscriptionFingerprint: string;
  providerSubscriptionId: string;
  providerCustomerId: string;
  providerPriceId?: string;
}) {
  if (
    subscription.provider !== "STRIPE"
    || subscription.enrollmentFingerprint !== input.subscriptionFingerprint
    || (subscription.providerSubscriptionId && subscription.providerSubscriptionId !== input.providerSubscriptionId)
    || (subscription.providerCustomerId && subscription.providerCustomerId !== input.providerCustomerId)
    || (input.providerPriceId && subscription.providerPriceId !== input.providerPriceId)
  ) {
    throw new Error("Stripe subscription identity does not match the prepared enrollment");
  }
}

export async function bindStripeSubscriptionEnrollment(rawInput: unknown) {
  const input = bindStripeSubscriptionEnrollmentSchema.parse(rawInput);
  return db.$transaction(async (tx) => {
    const subscription = await tx.subscription.findFirst({
      where: { id: input.subscriptionId, tenantId: input.tenantId },
    });
    if (!subscription) throw new Error("Stripe subscription enrollment not found");
    assertStripeIdentity(subscription, input);
    if (subscription.providerCheckoutId && subscription.providerCheckoutId !== input.providerCheckoutId) {
      throw new Error("Stripe Checkout Session does not match the prepared enrollment");
    }
    if (
      subscription.providerCheckoutId === input.providerCheckoutId
      && subscription.providerSubscriptionId === input.providerSubscriptionId
      && subscription.providerCustomerId === input.providerCustomerId
    ) {
      return { subscriptionId: subscription.id, status: subscription.status, idempotent: true };
    }
    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        providerCheckoutId: input.providerCheckoutId,
        providerSubscriptionId: input.providerSubscriptionId,
        providerCustomerId: input.providerCustomerId,
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: "PAYMENT_PROVIDER",
        actorId: "STRIPE",
        action: "STRIPE_SUBSCRIPTION_ENROLLMENT_BOUND",
        resourceType: "Subscription",
        resourceId: subscription.id,
        metadataJson: JSON.stringify({
          providerCheckoutId: input.providerCheckoutId,
          providerSubscriptionId: input.providerSubscriptionId,
          providerEventId: input.providerEventId,
        }),
      },
    });
    return { subscriptionId: subscription.id, status: subscription.status, idempotent: false };
  });
}

export async function expireStripeSubscriptionEnrollment(rawInput: unknown) {
  const input = expireStripeSubscriptionEnrollmentSchema.parse(rawInput);
  return db.$transaction(async (tx) => {
    const subscription = await tx.subscription.findFirst({
      where: { id: input.subscriptionId, tenantId: input.tenantId },
    });
    if (!subscription) throw new Error("Stripe subscription enrollment not found");
    if (
      subscription.provider !== "STRIPE"
      || subscription.enrollmentFingerprint !== input.subscriptionFingerprint
      || (subscription.providerCheckoutId && subscription.providerCheckoutId !== input.providerCheckoutId)
      || subscription.providerPriceId !== input.providerPriceId
    ) {
      throw new Error("Expired Stripe enrollment does not match the prepared subscription");
    }
    if (subscription.status !== "PENDING" || subscription.settledCycleCount > 0) {
      return { subscriptionId: subscription.id, status: subscription.status, idempotent: true };
    }
    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: "CANCELLED",
        providerCheckoutId: input.providerCheckoutId,
        cancelledAt: input.occurredAt,
        enrollmentLockKey: null,
        providerStateUpdatedAt: input.occurredAt,
        providerStateEventId: input.providerEventId,
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: "PAYMENT_PROVIDER",
        actorId: "STRIPE",
        action: "STRIPE_SUBSCRIPTION_ENROLLMENT_EXPIRED",
        resourceType: "Subscription",
        resourceId: subscription.id,
        metadataJson: JSON.stringify({ providerCheckoutId: input.providerCheckoutId }),
      },
    });
    return { subscriptionId: subscription.id, status: "CANCELLED", idempotent: false };
  });
}

async function findPriorStripeSettlement(
  input: z.infer<typeof settleStripeSubscriptionInvoiceSchema>,
): Promise<StripeSubscriptionSettlementReceipt | null> {
  const order = await db.order.findFirst({
    where: {
      tenantId: input.tenantId,
      OR: [
        { payments: { some: { provider: "STRIPE", providerEventId: input.providerEventId } } },
        { subscriptionCycle: { is: { providerInvoiceId: input.providerInvoiceId } } },
      ],
    },
    include: { subscriptionCycle: true, payments: true },
  });
  if (!order) return null;
  const cycle = order.subscriptionCycle;
  const payment = order.payments.find((candidate) => candidate.providerEventId === input.providerEventId);
  if (
    !cycle
    || cycle.subscriptionId !== input.subscriptionId
    || cycle.providerInvoiceId !== input.providerInvoiceId
    || cycle.status !== "SETTLED"
    || !cycle.settledAt
    || order.provider !== "STRIPE"
    || order.providerPaymentId !== input.providerPaymentId
    || order.paymentStatus !== "CAPTURED"
    || !payment
    || payment.providerPaymentId !== input.providerPaymentId
    || payment.amountCents !== input.capturedAmountCents
    || payment.currency !== input.currency
    || payment.payloadHash !== input.payloadHash
    || payment.processedAt?.getTime() !== input.occurredAt.getTime()
    || cycle.periodStartsAt.getTime() !== input.periodStartsAt.getTime()
    || cycle.periodEndsAt.getTime() !== input.periodEndsAt.getTime()
  ) {
    throw new Error("Stripe membership invoice conflicts with an existing settlement");
  }
  return {
    subscriptionId: cycle.subscriptionId,
    cycleId: cycle.id,
    cycleNumber: cycle.cycleNumber,
    orderId: order.id,
    orderNumber: order.orderNumber,
    paymentId: payment.id,
    campaignId: order.campaignId,
    entries: order.entryTotal,
    periodStartsAt: cycle.periodStartsAt,
    periodEndsAt: cycle.periodEndsAt,
    settledAt: cycle.settledAt,
    idempotent: true,
  };
}

function zeroEntryCalculation(input: {
  reason: string;
  subscriptionId: string;
  planId: string;
  providerInvoiceId: string;
  priceCents: number;
  currency: string;
  cycleNumber: number;
  periodStartsAt: Date;
  periodEndsAt: Date;
  campaignId?: string;
}) {
  return JSON.stringify({
    schemaVersion: 1,
    calculation: "MEMBERSHIP_ZERO_ENTRY_SETTLEMENT",
    reason: input.reason,
    subscriptionId: input.subscriptionId,
    planId: input.planId,
    providerInvoiceId: input.providerInvoiceId,
    priceCents: input.priceCents,
    currency: input.currency,
    cycleNumber: input.cycleNumber,
    periodStartsAt: input.periodStartsAt.toISOString(),
    periodEndsAt: input.periodEndsAt.toISOString(),
    campaignId: input.campaignId ?? null,
    awardedEntries: "0",
  });
}

/** Records every verified paid invoice, granting entries only for one eligible active campaign. */
export async function settleStripeSubscriptionInvoice(
  rawInput: unknown,
): Promise<StripeSubscriptionSettlementReceipt> {
  const input = settleStripeSubscriptionInvoiceSchema.parse(rawInput);
  const prior = await findPriorStripeSettlement(input);
  if (prior) return prior;

  for (let attempt = 1; attempt <= MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
      const subscription = await tx.subscription.findFirst({
        where: { id: input.subscriptionId, tenantId: input.tenantId },
        include: {
          tenant: true,
          entrant: true,
          user: true,
          plan: {
            include: {
              product: {
                include: { variants: { orderBy: { createdAt: "asc" }, take: 1 } },
              },
            },
          },
          cycles: { orderBy: { cycleNumber: "desc" }, take: 1 },
        },
      });
      if (!subscription) throw new Error("Stripe membership subscription not found");
      assertEnrollmentFingerprint(subscription);
      assertStripeIdentity(subscription, input);
      if (!subscription.user || subscription.userId !== subscription.entrant.userId) {
        throw new Error("Membership subscription user and entrant are no longer linked");
      }
      if (
        subscription.priceCents == null
        || !subscription.currency
        || !subscription.billingInterval
        || subscription.billingIntervalCount == null
        || subscription.priceCents !== input.capturedAmountCents
        || subscription.currency !== input.currency
        || subscription.providerPriceId !== input.providerPriceId
      ) {
        throw new Error("Stripe invoice does not match the immutable membership price snapshot");
      }
      if (subscription.currency !== subscription.tenant.currency) {
        throw new Error("Membership currency does not match the tenant currency");
      }
      if (input.periodEndsAt <= input.periodStartsAt) {
        throw new Error("Stripe membership invoice period is invalid");
      }
      const latestCycle = subscription.cycles[0] ?? null;
      if (subscription.settledCycleCount === 0 && input.billingReason !== "subscription_create") {
        throw new Error("Initial Stripe membership invoice must settle before a recurring invoice");
      }
      if (subscription.settledCycleCount > 0 && input.billingReason !== "subscription_cycle") {
        throw new Error("A Stripe subscription-create invoice cannot settle as a later cycle");
      }
      if (
        latestCycle
        && input.periodStartsAt < latestCycle.periodEndsAt
      ) {
        throw new Error("Stripe membership invoice period overlaps the last settled cycle");
      }

      const campaigns = await tx.campaign.findMany({
        where: {
          tenantId: input.tenantId,
          status: {
            in: [
              "LIVE",
              "ENTRY_CLOSED",
              "RECONCILING",
              "SNAPSHOT_REVIEW",
              "SEALED",
              "WINNER_PENDING",
              "COMPLETED",
              "ARCHIVED",
            ],
          },
          startsAt: { lte: input.occurredAt },
          endsAt: { gt: input.occurredAt },
        },
        include: { multiplierSlots: { orderBy: { startsAt: "asc" } } },
        orderBy: [{ startsAt: "desc" }, { id: "asc" }],
        take: 2,
      });
      if (campaigns.length > 1) {
        throw new Error("Multiple active campaigns make membership entry allocation ambiguous");
      }
      const campaign = campaigns[0] ?? null;
      const cycleNumber = subscription.settledCycleCount + 1;
      let entryAccount: { id: string; balance: bigint; version: number } | null = null;
      let entries = 0n;
      let baseEntries = 0n;
      let entryMultiplier = 1;
      let entryMultiplierDenominator = 1;
      let requiresEntryAdjustment = false;
      let calculationJson = zeroEntryCalculation({
        reason: "NO_ACTIVE_CAMPAIGN",
        subscriptionId: subscription.id,
        planId: subscription.planId,
        providerInvoiceId: input.providerInvoiceId,
        priceCents: subscription.priceCents,
        currency: subscription.currency,
        cycleNumber,
        periodStartsAt: input.periodStartsAt,
        periodEndsAt: input.periodEndsAt,
      });

      if (campaign) {
        let zeroReason: string | null = null;
        const releaseIntegrity = await inspectCampaignReleaseIntegrity(tx, campaign.id);
        if (!releaseIntegrity.valid) {
          zeroReason = "CAMPAIGN_RELEASE_INTEGRITY_INVALID";
        }
        if (!subscription.entrant.eligibilityAttested) {
          zeroReason = "ELIGIBILITY_NOT_ATTESTED";
        }
        const locationEligibility = evaluateCampaignLocationEligibility(campaign, {
          country: subscription.entrant.country,
          region: subscription.entrant.region ?? "",
        });
        if (!locationEligibility.eligible) {
          zeroReason = "CAMPAIGN_LOCATION_NOT_ELIGIBLE";
        }
        if (!zeroReason) {
          if (!campaign.officialRulesDocumentId || !campaign.officialRulesChecksum) {
            zeroReason = "EXACT_OFFICIAL_RULES_NOT_ACCEPTED";
          } else {
            const acceptance = await tx.rulesAcceptance.findFirst({
              where: {
                tenantId: input.tenantId,
                campaignId: campaign.id,
                entrantId: subscription.entrantId,
                legalDocumentId: campaign.officialRulesDocumentId,
                documentChecksum: campaign.officialRulesChecksum,
              },
              select: { id: true },
            });
            if (!acceptance) zeroReason = "EXACT_OFFICIAL_RULES_NOT_ACCEPTED";
          }
        }
        const campaignEntrant = await tx.campaignEntrant.findUnique({
          where: {
            campaignId_entrantId: {
              campaignId: campaign.id,
              entrantId: subscription.entrantId,
            },
          },
        });
        if (campaignEntrant && campaignEntrant.status !== "ELIGIBLE") {
          zeroReason = "CAMPAIGN_ENTRANT_NOT_ELIGIBLE";
        }
        if (!zeroReason && !campaignEntrant) {
          await tx.campaignEntrant.create({
            data: {
              campaignId: campaign.id,
              entrantId: subscription.entrantId,
              status: "ELIGIBLE",
              eligibilityJson: JSON.stringify({
                source: "STRIPE_SUBSCRIPTION_INVOICE",
                eligibilityAttested: true,
              }),
            },
          });
        }

        let bands: MembershipBand[] = [];
        if (!zeroReason) {
          const configuredBands = await tx.membershipEntryBand.findMany({
            where: { campaignId: campaign.id, planId: subscription.planId },
            orderBy: { minimumSettledCycles: "asc" },
          });
          bands = configuredBands.map((band) => ({
            id: band.id,
            minimumSettledCycles: band.minimumSettledCycles,
            maximumSettledCycles: band.maximumSettledCycles,
            fixedEntries: band.fixedEntries,
            multiplierNumerator: band.multiplierNumerator,
            multiplierDenominator: band.multiplierDenominator,
          }));
          try {
            selectMembershipEntryBand(bands, subscription.settledCycleCount);
          } catch {
            // A paid invoice is still authoritative monetary history. Missing or
            // ambiguous promotional configuration must produce a zero-entry
            // cycle for operator review, not make the verified webhook retry
            // forever after the member has already been charged.
            zeroReason = "MEMBERSHIP_ENTRY_BAND_INVALID";
          }
        }

        if (zeroReason) {
          calculationJson = zeroEntryCalculation({
            reason: zeroReason,
            subscriptionId: subscription.id,
            planId: subscription.planId,
            providerInvoiceId: input.providerInvoiceId,
            priceCents: subscription.priceCents,
            currency: subscription.currency,
            cycleNumber,
            periodStartsAt: input.periodStartsAt,
            periodEndsAt: input.periodEndsAt,
            campaignId: campaign.id,
          });
        } else {
          const multiplierResolution = resolveConfiguredCampaignMultiplier({
            currentMultiplier: campaign.currentMultiplier,
            slots: campaign.multiplierSlots,
            at: input.occurredAt,
          });
          entryAccount = await tx.entryAccount.upsert({
            where: {
              campaignId_entrantId: {
                campaignId: campaign.id,
                entrantId: subscription.entrantId,
              },
            },
            update: {},
            create: {
              tenantId: input.tenantId,
              campaignId: campaign.id,
              entrantId: subscription.entrantId,
            },
            select: { id: true, balance: true, version: true },
          });
          const reservedPositiveAdjustments = await tx.entryAdjustmentRequest.aggregate({
            where: {
              tenantId: input.tenantId,
              campaignId: campaign.id,
              entryAccountId: entryAccount.id,
              delta: { gt: 0n },
              status: { in: ["PENDING", "REVIEW", "APPROVED"] },
            },
            _sum: { delta: true },
          });
          const reservedEntries = reservedPositiveAdjustments._sum.delta ?? 0n;
          const remainingEntryCapacity = campaign.maxEntriesPerEntrant == null
            ? null
            : campaign.maxEntriesPerEntrant > entryAccount.balance + reservedEntries
              ? campaign.maxEntriesPerEntrant - entryAccount.balance - reservedEntries
              : 0n;
          const renewal = calculateRenewal({
            priceCents: subscription.priceCents,
            currency: subscription.currency,
            interval: parseBillingInterval(subscription.billingInterval),
            intervalCount: subscription.billingIntervalCount,
            settledCycleCount: subscription.settledCycleCount,
            currentPeriodStartsAt: subscription.currentPeriodStartsAt,
            currentPeriodEndsAt: subscription.currentPeriodEndsAt,
            capturedPeriod: { startsAt: input.periodStartsAt, endsAt: input.periodEndsAt },
            campaignMultiplier: multiplierResolution.factor,
            bands,
            remainingEntryCapacity,
          });
          entries = renewal.awardedEntries;
          baseEntries = renewal.baseEntries;
          entryMultiplier = renewal.band.multiplierNumerator * multiplierResolution.factor;
          entryMultiplierDenominator = renewal.band.multiplierDenominator;
          requiresEntryAdjustment = entries > 0n
            && !["LIVE", "ENTRY_CLOSED", "RECONCILING"].includes(campaign.status);
          if (requiresEntryAdjustment) {
            // The account version is also the reservation mutex. Pending and
            // in-review positive adjustments do not change balance, so the
            // compare-and-swap prevents two delayed invoices from both using
            // the same remaining cap while preserving their paid-cycle truth.
            const reservation = await tx.entryAccount.updateMany({
              where: {
                id: entryAccount.id,
                tenantId: input.tenantId,
                campaignId: campaign.id,
                balance: entryAccount.balance,
                version: entryAccount.version,
              },
              data: { version: { increment: 1 } },
            });
            if (reservation.count !== 1) throw new MembershipEntryClaimConflict();
          }
          calculationJson = JSON.stringify({
            ...renewal.snapshot,
            campaignId: campaign.id,
            campaignCode: campaign.code,
            campaignRulesVersion: campaign.rulesVersion,
            campaignConfigHash: campaign.configChecksum,
            multiplierResolution: multiplierResolution.snapshot,
            planId: subscription.planId,
            subscriptionId: subscription.id,
            providerInvoiceId: input.providerInvoiceId,
            reservedPositiveAdjustmentsBeforeInvoice: reservedEntries.toString(),
            postingStatus: requiresEntryAdjustment ? "PENDING_DUAL_CONTROL_ADJUSTMENT" : "POSTED",
          });
        }
      }

      const stateIsNewest = !subscription.providerStateUpdatedAt
        || input.occurredAt >= subscription.providerStateUpdatedAt;
      const nextStatus = subscription.status === "CANCELLED"
        ? "CANCELLED"
        : !stateIsNewest && subscription.status === "PAST_DUE"
          ? "PAST_DUE"
          : "ACTIVE";
      const advanced = await tx.subscription.updateMany({
        where: {
          id: subscription.id,
          tenantId: input.tenantId,
          settledCycleCount: subscription.settledCycleCount,
          enrollmentFingerprint: input.subscriptionFingerprint,
          OR: [
            { providerSubscriptionId: null },
            { providerSubscriptionId: input.providerSubscriptionId },
          ],
        },
        data: {
          providerSubscriptionId: input.providerSubscriptionId,
          providerCustomerId: input.providerCustomerId,
          settledCycleCount: { increment: 1 },
          campaignId: campaign?.id ?? null,
          currentPeriodStartsAt: input.periodStartsAt,
          currentPeriodEndsAt: input.periodEndsAt,
          status: nextStatus,
          ...(stateIsNewest ? {
            providerStateUpdatedAt: input.occurredAt,
            providerStateEventId: input.providerEventId,
          } : {}),
        },
      });
      if (advanced.count !== 1) {
        throw new Error("Stripe membership changed while its invoice was settling");
      }

      const orderIdempotencyKey = `stripe-membership-invoice:${sha256(`${input.tenantId}:${input.providerInvoiceId}`)}`;
      const order = await tx.order.create({
        data: {
          tenantId: input.tenantId,
          campaignId: campaign?.id ?? null,
          entrantId: subscription.entrantId,
          userId: subscription.userId,
          orderNumber: `MBR-${sha256(`${input.tenantId}:${input.providerInvoiceId}`).slice(0, 16).toUpperCase()}`,
          channel: "SUBSCRIPTION",
          status: "CONFIRMED",
          paymentStatus: "CAPTURED",
          fulfillmentStatus: "FULFILLED",
          email: subscription.user.email,
          customerName: subscription.user.name,
          currency: subscription.currency,
          subtotalCents: subscription.priceCents,
          discountCents: 0,
          shippingCents: 0,
          taxCents: 0,
          totalCents: subscription.priceCents,
          entryTotal: requiresEntryAdjustment ? 0n : entries,
          shippingAddressJson: JSON.stringify({ kind: "NONE", reason: "DIGITAL_MEMBERSHIP" }),
          provider: "STRIPE",
          providerPaymentId: input.providerPaymentId,
          idempotencyKey: orderIdempotencyKey,
          paidAt: input.occurredAt,
        },
      });
      const variant = subscription.plan.product.variants[0] ?? null;
      const orderLine = await tx.orderLine.create({
        data: {
          orderId: order.id,
          productId: subscription.plan.productId,
          variantId: variant?.id ?? null,
          productTitle: subscription.plan.product.title,
          variantTitle: variant?.title ?? null,
          sku: variant?.sku ?? null,
          quantity: 1,
          unitPriceCents: subscription.priceCents,
          discountCents: 0,
          qualifyingCents: subscription.priceCents,
          entryMultiplier,
          entryMultiplierDenominator,
          entries: requiresEntryAdjustment ? 0n : entries,
          entryCalculationJson: calculationJson,
        },
      });
      const payment = await tx.payment.create({
        data: {
          orderId: order.id,
          provider: "STRIPE",
          providerEventId: input.providerEventId,
          providerPaymentId: input.providerPaymentId,
          status: "CAPTURED",
          amountCents: subscription.priceCents,
          currency: subscription.currency,
          payloadHash: input.payloadHash,
          idempotencyKey: `stripe-membership-payment:${sha256(`${input.tenantId}:${input.providerInvoiceId}`)}`,
          processedAt: input.occurredAt,
        },
      });
      const cycle = await tx.subscriptionCycle.create({
        data: {
          subscriptionId: subscription.id,
          orderId: order.id,
          cycleNumber,
          status: "SETTLED",
          periodStartsAt: input.periodStartsAt,
          periodEndsAt: input.periodEndsAt,
          settledAt: input.occurredAt,
          baseEntries,
          multiplierNumerator: entryMultiplier,
          multiplierDenominator: entryMultiplierDenominator,
          providerInvoiceId: input.providerInvoiceId,
        },
      });

      let adjustmentRequestId: string | null = null;
      if (requiresEntryAdjustment && entryAccount && campaign) {
        const adjustment = await tx.entryAdjustmentRequest.create({
          data: {
            tenantId: input.tenantId,
            campaignId: campaign.id,
            entryAccountId: entryAccount.id,
            subscriptionCycleId: cycle.id,
            requestedBy: "STRIPE",
            kind: "LATE_SUBSCRIPTION_GRANT",
            delta: entries,
            reasonCode: "PAID_SUBSCRIPTION_INVOICE_AFTER_ENTRY_FREEZE",
            explanation: `Stripe invoice ${input.providerInvoiceId} was paid during the campaign entry period but arrived after the entry population froze. Monetary settlement is final; ${entries.toString()} entries require dual-control reconciliation.`,
            evidenceRef: `stripe:invoice:${input.providerInvoiceId}`,
          },
        });
        adjustmentRequestId = adjustment.id;
      }

      if (entryAccount && entries > 0n && campaign && !requiresEntryAdjustment) {
        const entitlement = await tx.entryEntitlement.create({
          data: {
            tenantId: input.tenantId,
            entryAccountId: entryAccount.id,
            orderId: order.id,
            orderLineId: orderLine.id,
            originType: "SUBSCRIPTION_CYCLE",
            status: "POSTED",
            originalEntries: entries,
            calculationJson,
            campaignConfigHash: campaign.configChecksum,
            idempotencyKey: `stripe-membership-entitlement:${input.providerInvoiceId}`,
            effectiveAt: input.occurredAt,
          },
        });
        await tx.entryLedgerEvent.create({
          data: {
            tenantId: input.tenantId,
            entryAccountId: entryAccount.id,
            entitlementId: entitlement.id,
            kind: "GRANT",
            delta: entries,
            idempotencyKey: `stripe-membership-ledger:${input.providerInvoiceId}`,
            effectiveAt: input.occurredAt,
            actorType: "PAYMENT_PROVIDER",
            actorId: "STRIPE",
            reasonCode: "STRIPE_SUBSCRIPTION_INVOICE_PAID",
            metadataJson: JSON.stringify({
              subscriptionId: subscription.id,
              cycleId: cycle.id,
              providerInvoiceId: input.providerInvoiceId,
            }),
          },
        });
        const accountUpdate = await tx.entryAccount.updateMany({
          where: { id: entryAccount.id, balance: entryAccount.balance, version: entryAccount.version },
          data: { balance: { increment: entries }, version: { increment: 1 } },
        });
        if (accountUpdate.count !== 1) {
          throw new Error("Membership invoice settlement lost its entry-cap claim");
        }
      }

      await tx.auditEvent.create({
        data: {
          tenantId: input.tenantId,
          actorType: "PAYMENT_PROVIDER",
          actorId: "STRIPE",
          action: cycleNumber === 1
            ? "STRIPE_SUBSCRIPTION_INITIAL_INVOICE_SETTLED"
            : "STRIPE_SUBSCRIPTION_RENEWAL_SETTLED",
          resourceType: "SubscriptionCycle",
          resourceId: cycle.id,
          metadataJson: JSON.stringify({
            subscriptionId: subscription.id,
            cycleNumber,
            providerInvoiceId: input.providerInvoiceId,
            orderNumber: order.orderNumber,
            entriesCalculated: entries.toString(),
            entriesPosted: requiresEntryAdjustment ? "0" : entries.toString(),
            adjustmentRequestId,
          }),
        },
      });
      await tx.outboxEvent.createMany({
        data: [
          ...(cycleNumber === 1 ? [{
            tenantId: input.tenantId,
            aggregateType: "Subscription",
            aggregateId: subscription.id,
            kind: "SUBSCRIPTION_CREATED_NOTIFICATION",
            payloadJson: JSON.stringify({ subscriptionId: subscription.id }),
            idempotencyKey: `subscription-created:${subscription.id}`,
          }] : []),
          {
            tenantId: input.tenantId,
            aggregateType: "SubscriptionCycle",
            aggregateId: cycle.id,
            kind: "SUBSCRIPTION_RENEWAL_RECEIPT",
            payloadJson: JSON.stringify({
              subscriptionId: subscription.id,
              cycleId: cycle.id,
              orderId: order.id,
            }),
            idempotencyKey: `subscription-renewal-receipt:${cycle.id}`,
          },
        ],
      });
      return {
        subscriptionId: subscription.id,
        cycleId: cycle.id,
        cycleNumber,
        orderId: order.id,
        orderNumber: order.orderNumber,
        paymentId: payment.id,
        campaignId: campaign?.id ?? null,
        entries: requiresEntryAdjustment ? 0n : entries,
        periodStartsAt: input.periodStartsAt,
        periodEndsAt: input.periodEndsAt,
        settledAt: input.occurredAt,
        idempotent: false,
      };
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 15_000,
      });
    } catch (error) {
      const raced = await findPriorStripeSettlement(input);
      if (raced) return raced;
      if (!isRetryableSettlementConflict(error) || attempt === MAX_SETTLEMENT_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 10));
    }
  }
  throw new Error("Stripe membership invoice settlement exhausted its serialization retries");
}

export async function failStripeSubscriptionInvoice(rawInput: unknown) {
  const input = failStripeSubscriptionInvoiceSchema.parse(rawInput);
  return db.$transaction(async (tx) => {
    const subscription = await tx.subscription.findFirst({
      where: { id: input.subscriptionId, tenantId: input.tenantId },
    });
    if (!subscription) throw new Error("Stripe membership subscription not found");
    assertEnrollmentFingerprint(subscription);
    assertStripeIdentity(subscription, input);
    if (subscription.providerPriceId !== input.providerPriceId) {
      throw new Error("Failed Stripe invoice does not match the prepared membership price");
    }
    if (
      subscription.providerStateUpdatedAt
      && (
        input.occurredAt < subscription.providerStateUpdatedAt
        || (
          input.occurredAt.getTime() === subscription.providerStateUpdatedAt.getTime()
          && subscription.providerStateEventId === input.providerEventId
        )
      )
    ) {
      return { subscriptionId: subscription.id, status: subscription.status, idempotent: true };
    }
    const status = subscription.status === "CANCELLED" ? "CANCELLED" : "PAST_DUE";
    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        providerSubscriptionId: input.providerSubscriptionId,
        providerCustomerId: input.providerCustomerId,
        status,
        providerStateUpdatedAt: input.occurredAt,
        providerStateEventId: input.providerEventId,
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: "PAYMENT_PROVIDER",
        actorId: "STRIPE",
        action: "STRIPE_SUBSCRIPTION_INVOICE_PAYMENT_FAILED",
        resourceType: "Subscription",
        resourceId: subscription.id,
        metadataJson: JSON.stringify({
          providerInvoiceId: input.providerInvoiceId,
          providerEventId: input.providerEventId,
        }),
      },
    });
    return { subscriptionId: subscription.id, status, idempotent: false };
  });
}

function localProviderStatus(
  providerStatus: z.infer<typeof applyStripeSubscriptionStateSchema>["providerStatus"],
  settledCycleCount: number,
) {
  switch (providerStatus) {
    case "active":
    case "trialing":
      return settledCycleCount > 0 ? "ACTIVE" : "PENDING";
    case "past_due":
    case "unpaid":
    case "paused":
      return "PAST_DUE";
    case "canceled":
    case "incomplete_expired":
      return "CANCELLED";
    case "incomplete":
      return "PENDING";
  }
}

export async function applyStripeSubscriptionState(rawInput: unknown) {
  const input = applyStripeSubscriptionStateSchema.parse(rawInput);
  return db.$transaction(async (tx) => {
    const subscription = await tx.subscription.findFirst({
      where: { id: input.subscriptionId, tenantId: input.tenantId },
    });
    if (!subscription) throw new Error("Stripe membership subscription not found");
    assertEnrollmentFingerprint(subscription);
    assertStripeIdentity(subscription, input);
    if (
      subscription.priceCents !== input.priceCents
      || subscription.currency !== input.currency
      || subscription.billingInterval !== input.billingInterval
      || subscription.billingIntervalCount !== input.billingIntervalCount
    ) {
      throw new Error("Stripe subscription state changed the authoritative membership price");
    }
    if (input.periodEndsAt <= input.periodStartsAt) {
      throw new Error("Stripe subscription state contains an invalid period");
    }
    if (
      subscription.providerStateUpdatedAt
      && (
        input.occurredAt < subscription.providerStateUpdatedAt
        || (
          input.occurredAt.getTime() === subscription.providerStateUpdatedAt.getTime()
          && subscription.providerStateEventId === input.providerEventId
        )
      )
    ) {
      return { subscriptionId: subscription.id, status: subscription.status, idempotent: true };
    }
    if (
      subscription.status === "CANCELLED"
      && !["canceled", "incomplete_expired"].includes(input.providerStatus)
    ) {
      return { subscriptionId: subscription.id, status: subscription.status, idempotent: true };
    }
    const status = localProviderStatus(input.providerStatus, subscription.settledCycleCount);
    const becameCancelled = status === "CANCELLED" && subscription.status !== "CANCELLED";
    const scheduledCancellation = input.cancelAtPeriodEnd && !subscription.cancelAtPeriodEnd;
    const cancelledAt = status === "CANCELLED"
      ? input.endedAt ?? input.occurredAt
      : null;
    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        providerSubscriptionId: input.providerSubscriptionId,
        providerCustomerId: input.providerCustomerId,
        status,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd,
        currentPeriodStartsAt: input.periodStartsAt,
        currentPeriodEndsAt: input.periodEndsAt,
        cancelledAt,
        enrollmentLockKey: status === "CANCELLED" ? null : subscription.enrollmentLockKey,
        providerStateUpdatedAt: input.occurredAt,
        providerStateEventId: input.providerEventId,
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: "PAYMENT_PROVIDER",
        actorId: "STRIPE",
        action: "STRIPE_SUBSCRIPTION_STATE_UPDATED",
        resourceType: "Subscription",
        resourceId: subscription.id,
        metadataJson: JSON.stringify({
          providerEventId: input.providerEventId,
          providerStatus: input.providerStatus,
          localStatus: status,
          cancelAtPeriodEnd: input.cancelAtPeriodEnd,
        }),
      },
    });
    if (scheduledCancellation) {
      await tx.outboxEvent.create({
        data: {
          tenantId: input.tenantId,
          aggregateType: "Subscription",
          aggregateId: subscription.id,
          kind: "SUBSCRIPTION_CANCELLATION_SCHEDULED",
          payloadJson: JSON.stringify({
            subscriptionId: subscription.id,
            effectiveAt: input.periodEndsAt.toISOString(),
          }),
          idempotencyKey: `subscription-cancellation-scheduled:${subscription.id}:${input.providerEventId}`,
        },
      });
    }
    if (becameCancelled) {
      await tx.outboxEvent.create({
        data: {
          tenantId: input.tenantId,
          aggregateType: "Subscription",
          aggregateId: subscription.id,
          kind: "SUBSCRIPTION_CANCELLED",
          payloadJson: JSON.stringify({ subscriptionId: subscription.id }),
          idempotencyKey: `subscription-cancelled:${subscription.id}`,
        },
      });
    }
    return { subscriptionId: subscription.id, status, idempotent: false };
  });
}

export async function createStripeBillingPortal(
  rawInput: unknown,
  boundary: StripeHostedSubscriptionBoundary = getStripeHostedSubscriptionBoundary(),
) {
  const input = z.object({
    tenantId: databaseId,
    subscriptionId: databaseId,
    userId: databaseId,
    idempotencyKey: z.string().trim().min(8).max(200),
  }).strict().parse(rawInput);
  const subscription = await db.subscription.findFirst({
    where: {
      id: input.subscriptionId,
      tenantId: input.tenantId,
      userId: input.userId,
      provider: "STRIPE",
      status: { in: ["PENDING", "ACTIVE", "PAST_DUE"] },
    },
    select: { id: true, providerCustomerId: true },
  });
  if (!subscription || !subscription.providerCustomerId) {
    throw new Error("Stripe billing management is not yet available for this membership");
  }
  const returnUrl = new URL("/account/membership", canonicalAppUrl()).toString();
  return boundary.createBillingPortal({
    providerCustomerId: subscription.providerCustomerId,
    returnUrl,
    idempotencyKey: `stripe-billing-portal:${sha256(`${input.tenantId}:${subscription.id}:${input.idempotencyKey}`)}`,
  });
}
