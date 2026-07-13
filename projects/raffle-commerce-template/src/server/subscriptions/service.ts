import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/server/db";
import { resolveConfiguredCampaignMultiplier } from "@/server/commerce/multiplier";
import { assertCampaignLocationEligible } from "@/server/campaigns/eligibility";
import {
  billingIntervals,
  calculatePeriodEnd,
  calculateRenewal,
  type BillingInterval,
  type MembershipBand,
} from "./calculation";
import {
  cancelSubscriptionAtPeriodEndSchema,
  createDemoSubscriptionSchema,
  finalizeSubscriptionCancellationSchema,
  settleDemoSubscriptionRenewalSchema,
  settleSubscriptionRenewalSchema,
  type SettleSubscriptionRenewalInput,
} from "./validation";

const renewableStatuses = ["ACTIVE", "PAST_DUE"] as const;

function assertDemoMutationsEnabled() {
  if (process.env.DEMO_MODE !== "true") {
    throw new Error("Synthetic subscription mutation is disabled outside demo mode");
  }
}

export type SubscriptionReceipt = {
  subscriptionId: string;
  tenantId: string;
  planId: string;
  entrantId: string;
  userId: string | null;
  campaignId: string | null;
  status: string;
  provider: string;
  providerSubscriptionId: string | null;
  settledCycleCount: number;
  currentPeriodStartsAt: Date;
  currentPeriodEndsAt: Date;
  cancelAtPeriodEnd: boolean;
  cancelledAt: Date | null;
  idempotent: boolean;
};

export type RenewalSettlementReceipt = {
  subscriptionId: string;
  cycleId: string;
  cycleNumber: number;
  orderId: string;
  orderNumber: string;
  paymentId: string;
  campaignId: string;
  entries: bigint;
  periodStartsAt: Date;
  periodEndsAt: Date;
  settledAt: Date;
  idempotent: boolean;
};

export type CancellationReceipt = {
  subscriptionId: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  effectiveAt: Date;
  cancelledAt: Date | null;
  finalized: boolean;
  idempotent: boolean;
};

type SettlementOrder = {
  id: string;
  tenantId: string;
  campaignId: string | null;
  orderNumber: string;
  provider: string;
  providerPaymentId: string | null;
  entryTotal: bigint;
  paymentStatus: string;
  subscriptionCycle: null | {
    id: string;
    subscriptionId: string;
    cycleNumber: number;
    status: string;
    periodStartsAt: Date;
    periodEndsAt: Date;
    settledAt: Date | null;
  };
  payments: Array<{
    id: string;
    provider: string;
    providerEventId: string | null;
    providerPaymentId: string | null;
    status: string;
    amountCents: number;
    currency: string;
    payloadHash: string | null;
    processedAt: Date | null;
  }>;
};

type SettlementReadClient = Pick<Prisma.TransactionClient, "order" | "payment">;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function namespacedHash(namespace: string, ...values: string[]) {
  return `${namespace}:${sha256(values.join(":"))}`;
}

function demoProviderId(prefix: string, ...values: string[]) {
  return `${prefix}_${sha256(values.join(":"))}`;
}

function isUniqueConstraintError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function parseBillingInterval(value: string): BillingInterval {
  const normalized = value.toUpperCase();
  if (!billingIntervals.includes(normalized as BillingInterval)) {
    throw new Error(`Unsupported subscription interval: ${value}`);
  }
  return normalized as BillingInterval;
}

function subscriptionReceipt(subscription: {
  id: string;
  tenantId: string;
  planId: string;
  entrantId: string;
  userId: string | null;
  campaignId: string | null;
  status: string;
  provider: string;
  providerSubscriptionId: string | null;
  settledCycleCount: number;
  currentPeriodStartsAt: Date;
  currentPeriodEndsAt: Date;
  cancelAtPeriodEnd: boolean;
  cancelledAt: Date | null;
}, idempotent: boolean): SubscriptionReceipt {
  return {
    subscriptionId: subscription.id,
    tenantId: subscription.tenantId,
    planId: subscription.planId,
    entrantId: subscription.entrantId,
    userId: subscription.userId,
    campaignId: subscription.campaignId,
    status: subscription.status,
    provider: subscription.provider,
    providerSubscriptionId: subscription.providerSubscriptionId,
    settledCycleCount: subscription.settledCycleCount,
    currentPeriodStartsAt: subscription.currentPeriodStartsAt,
    currentPeriodEndsAt: subscription.currentPeriodEndsAt,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    cancelledAt: subscription.cancelledAt,
    idempotent,
  };
}

function assertSameDemoEnrollment(subscription: {
  planId: string;
  entrantId: string;
  userId: string | null;
}, input: {
  planId: string;
  entrantId: string;
  userId: string;
}) {
  if (
    subscription.planId !== input.planId
    || subscription.entrantId !== input.entrantId
    || subscription.userId !== input.userId
  ) {
    throw new Error("Subscription idempotency key was already used for a different enrollment");
  }
}

function renewalOrderIdempotencyKey(input: Pick<SettleSubscriptionRenewalInput, "tenantId" | "subscriptionId" | "idempotencyKey">) {
  return namespacedHash("subscription-renewal", input.tenantId, input.subscriptionId, input.idempotencyKey);
}

function assertAndMapPriorSettlement(
  order: SettlementOrder,
  input: SettleSubscriptionRenewalInput,
): RenewalSettlementReceipt {
  const cycle = order.subscriptionCycle;
  const payment = order.payments.find((candidate) => (
    candidate.provider === input.provider
    && candidate.providerEventId === input.providerEventId
  ));

  if (
    !cycle
    || cycle.subscriptionId !== input.subscriptionId
    || order.tenantId !== input.tenantId
    || order.provider !== input.provider
    || order.providerPaymentId !== input.providerPaymentId
    || order.paymentStatus !== "CAPTURED"
    || cycle.status !== "SETTLED"
    || !cycle.settledAt
    || !order.campaignId
    || !payment
    || payment.providerPaymentId !== input.providerPaymentId
    || payment.status !== "CAPTURED"
    || payment.amountCents !== input.capturedAmountCents
    || payment.currency !== input.currency
    || payment.payloadHash !== input.payloadHash
    || payment.processedAt?.getTime() !== input.occurredAt.getTime()
  ) {
    throw new Error("Renewal idempotency key or provider event conflicts with an existing transaction");
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

async function findPriorSettlement(
  client: SettlementReadClient,
  input: SettleSubscriptionRenewalInput,
): Promise<RenewalSettlementReceipt | null> {
  const orderKey = renewalOrderIdempotencyKey(input);
  const priorOrder = await client.order.findUnique({
    where: {
      tenantId_idempotencyKey: {
        tenantId: input.tenantId,
        idempotencyKey: orderKey,
      },
    },
    include: { subscriptionCycle: true, payments: true },
  });
  if (priorOrder) return assertAndMapPriorSettlement(priorOrder, input);

  const priorPayment = await client.payment.findUnique({
    where: {
      provider_providerEventId: {
        provider: input.provider,
        providerEventId: input.providerEventId,
      },
    },
    include: {
      order: { include: { subscriptionCycle: true, payments: true } },
    },
  });
  if (priorPayment) return assertAndMapPriorSettlement(priorPayment.order, input);
  return null;
}

/**
 * Creates a provider-shaped demo subscription without trusting any caller price
 * or period. The idempotency key is represented by a deterministic provider id;
 * reusing it with different enrollment identities fails closed.
 */
export async function createDemoSubscription(rawInput: unknown): Promise<SubscriptionReceipt> {
  assertDemoMutationsEnabled();
  const input = createDemoSubscriptionSchema.parse(rawInput);
  const providerSubscriptionId = demoProviderId(
    "demo_sub",
    input.tenantId,
    input.idempotencyKey,
  );

  const existing = await db.subscription.findUnique({
    where: {
      tenantId_provider_providerSubscriptionId: {
        tenantId: input.tenantId,
        provider: "DEMO",
        providerSubscriptionId,
      },
    },
  });
  if (existing) {
    assertSameDemoEnrollment(existing, input);
    return subscriptionReceipt(existing, true);
  }

  try {
    return await db.$transaction(async (tx) => {
      const [tenant, plan, entrant, user] = await Promise.all([
        tx.tenant.findUnique({ where: { id: input.tenantId } }),
        tx.subscriptionPlan.findFirst({
          where: { id: input.planId, tenantId: input.tenantId },
          include: { product: true },
        }),
        tx.entrant.findFirst({
          where: { id: input.entrantId, tenantId: input.tenantId },
        }),
        tx.user.findFirst({
          where: { id: input.userId, tenantId: input.tenantId },
        }),
      ]);

      if (!tenant || tenant.status !== "ACTIVE") throw new Error("Tenant is unavailable");
      if (!plan || plan.status !== "ACTIVE") throw new Error("Subscription plan is unavailable");
      if (plan.product.status !== "ACTIVE" || plan.product.productType !== "MEMBERSHIP") {
        throw new Error("Subscription plan is not attached to an active membership product");
      }
      if (!Number.isSafeInteger(plan.priceCents) || plan.priceCents < 1) {
        throw new Error("Subscription plan price is invalid");
      }
      if (plan.currency !== tenant.currency) {
        throw new Error("Subscription plan currency does not match the tenant currency");
      }
      if (!entrant || !user || user.status !== "ACTIVE" || entrant.userId !== user.id) {
        throw new Error("Subscription entrant and active user are not linked in this tenant");
      }

      const duplicateActiveSubscription = await tx.subscription.findFirst({
        where: {
          tenantId: input.tenantId,
          planId: input.planId,
          entrantId: input.entrantId,
          status: { in: [...renewableStatuses] },
        },
        select: { id: true },
      });
      if (duplicateActiveSubscription) {
        throw new Error("Entrant already has an active subscription to this plan");
      }

      const now = new Date();
      const interval = parseBillingInterval(plan.interval);
      const currentPeriodEndsAt = calculatePeriodEnd(now, interval, plan.intervalCount);
      const campaign = await tx.campaign.findFirst({
        where: {
          tenantId: input.tenantId,
          status: "LIVE",
          startsAt: { lte: now },
          endsAt: { gt: now },
        },
        orderBy: [{ startsAt: "desc" }, { id: "asc" }],
        select: { id: true },
      });

      const created = await tx.subscription.create({
        data: {
          tenantId: input.tenantId,
          planId: input.planId,
          userId: input.userId,
          entrantId: input.entrantId,
          campaignId: campaign?.id ?? null,
          status: "ACTIVE",
          provider: "DEMO",
          providerSubscriptionId,
          settledCycleCount: 0,
          continuousSince: now,
          currentPeriodStartsAt: now,
          currentPeriodEndsAt,
        },
      });

      await tx.auditEvent.create({
        data: {
          tenantId: input.tenantId,
          actorType: "USER",
          actorId: input.userId,
          action: "DEMO_SUBSCRIPTION_CREATED",
          resourceType: "Subscription",
          resourceId: created.id,
          metadataJson: JSON.stringify({
            planId: input.planId,
            providerSubscriptionId,
          }),
        },
      });
      await tx.outboxEvent.create({
        data: {
          tenantId: input.tenantId,
          aggregateType: "Subscription",
          aggregateId: created.id,
          kind: "SUBSCRIPTION_CREATED_NOTIFICATION",
          payloadJson: JSON.stringify({ subscriptionId: created.id }),
          idempotencyKey: `subscription-created:${created.id}`,
        },
      });

      return subscriptionReceipt(created, false);
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const prior = await db.subscription.findUnique({
      where: {
        tenantId_provider_providerSubscriptionId: {
          tenantId: input.tenantId,
          provider: "DEMO",
          providerSubscriptionId,
        },
      },
    });
    if (!prior) throw error;
    assertSameDemoEnrollment(prior, input);
    return subscriptionReceipt(prior, true);
  }
}

/**
 * Settles one verified provider capture. The current plan, product, campaign,
 * tenure band, cap, and account balance are all re-read inside the transaction.
 */
export async function settleSubscriptionRenewal(rawInput: unknown): Promise<RenewalSettlementReceipt> {
  const input = settleSubscriptionRenewalSchema.parse(rawInput);
  const prior = await findPriorSettlement(db, input);
  if (prior) return prior;

  try {
    return await db.$transaction(async (tx) => {
      const transactionPrior = await findPriorSettlement(tx, input);
      if (transactionPrior) return transactionPrior;

      const subscription = await tx.subscription.findFirst({
        where: { id: input.subscriptionId, tenantId: input.tenantId },
        include: {
          tenant: true,
          entrant: true,
          user: true,
          plan: {
            include: {
              product: {
                include: {
                  variants: {
                    where: { status: "ACTIVE" },
                    orderBy: { createdAt: "asc" },
                    take: 1,
                  },
                },
              },
            },
          },
        },
      });
      if (!subscription) throw new Error("Subscription not found");
      if (subscription.tenant.status !== "ACTIVE") throw new Error("Tenant is unavailable");
      if (!renewableStatuses.includes(subscription.status as (typeof renewableStatuses)[number])) {
        throw new Error(`Subscription in status ${subscription.status} cannot renew`);
      }
      if (subscription.cancelAtPeriodEnd) {
        throw new Error("Subscription is scheduled to cancel and cannot renew");
      }
      if (subscription.provider.toUpperCase() !== input.provider) {
        throw new Error("Captured payment provider does not match the subscription provider");
      }
      if (!subscription.providerSubscriptionId) {
        throw new Error("Subscription is missing its provider subscription id");
      }
      if (subscription.plan.status !== "ACTIVE") throw new Error("Subscription plan is unavailable");
      if (
        subscription.plan.product.status !== "ACTIVE"
        || subscription.plan.product.productType !== "MEMBERSHIP"
      ) {
        throw new Error("Subscription plan is not attached to an active membership product");
      }
      if (
        !subscription.user
        || subscription.user.status !== "ACTIVE"
        || subscription.entrant.userId !== subscription.user.id
      ) {
        throw new Error("Subscription entrant and active user are no longer linked");
      }
      if (!subscription.entrant.eligibilityAttested) {
        throw new Error("Entrant eligibility must be attested before renewal entries can post");
      }
      if (
        subscription.plan.priceCents !== input.capturedAmountCents
        || subscription.plan.currency !== input.currency
      ) {
        throw new Error("Captured amount does not match the authoritative subscription plan price");
      }
      if (subscription.plan.currency !== subscription.tenant.currency) {
        throw new Error("Subscription plan currency does not match the tenant currency");
      }
      const earliestCaptureAt = subscription.settledCycleCount === 0
        ? subscription.currentPeriodStartsAt
        : subscription.currentPeriodEndsAt;
      if (input.occurredAt < earliestCaptureAt) {
        throw new Error(subscription.settledCycleCount === 0
          ? "Initial capture predates the current subscription period"
          : "Captured renewal predates the next subscription period");
      }

      const campaigns = await tx.campaign.findMany({
        where: {
          tenantId: input.tenantId,
          status: "LIVE",
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
      const campaign = campaigns[0];
      if (!campaign) {
        throw new Error("No entry-eligible campaign was active when the renewal was captured");
      }
      assertCampaignLocationEligible(campaign, {
        country: subscription.entrant.country,
        region: subscription.entrant.region ?? "",
      });
      const multiplierResolution = resolveConfiguredCampaignMultiplier({
        currentMultiplier: campaign.currentMultiplier,
        slots: campaign.multiplierSlots,
        at: input.occurredAt,
      });

      const configuredBands = await tx.membershipEntryBand.findMany({
        where: { campaignId: campaign.id, planId: subscription.planId },
        orderBy: { minimumSettledCycles: "asc" },
      });
      const bands: MembershipBand[] = configuredBands.map((band) => ({
        id: band.id,
        minimumSettledCycles: band.minimumSettledCycles,
        maximumSettledCycles: band.maximumSettledCycles,
        fixedEntries: band.fixedEntries,
        multiplierNumerator: band.multiplierNumerator,
        multiplierDenominator: band.multiplierDenominator,
      }));

      const campaignEntrant = await tx.campaignEntrant.findUnique({
        where: {
          campaignId_entrantId: {
            campaignId: campaign.id,
            entrantId: subscription.entrantId,
          },
        },
      });
      if (campaignEntrant && campaignEntrant.status !== "ELIGIBLE") {
        throw new Error("Entrant is not eligible for the active campaign");
      }
      if (!campaignEntrant) {
        await tx.campaignEntrant.create({
          data: {
            campaignId: campaign.id,
            entrantId: subscription.entrantId,
            status: "ELIGIBLE",
            eligibilityJson: JSON.stringify({
              source: "SUBSCRIPTION_RENEWAL",
              eligibilityAttested: true,
            }),
          },
        });
      }

      const account = await tx.entryAccount.upsert({
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
      });
      const remainingEntryCapacity = campaign.maxEntriesPerEntrant == null
        ? null
        : campaign.maxEntriesPerEntrant > account.balance
          ? campaign.maxEntriesPerEntrant - account.balance
          : 0n;
      const interval = parseBillingInterval(subscription.plan.interval);
      const renewal = calculateRenewal({
        priceCents: subscription.plan.priceCents,
        currency: subscription.plan.currency,
        interval,
        intervalCount: subscription.plan.intervalCount,
        settledCycleCount: subscription.settledCycleCount,
        currentPeriodStartsAt: subscription.currentPeriodStartsAt,
        currentPeriodEndsAt: subscription.currentPeriodEndsAt,
        bands,
        campaignMultiplier: multiplierResolution.factor,
        remainingEntryCapacity,
      });

      const periodAdvance = await tx.subscription.updateMany({
        where: {
          id: subscription.id,
          tenantId: input.tenantId,
          status: { in: [...renewableStatuses] },
          cancelAtPeriodEnd: false,
          settledCycleCount: subscription.settledCycleCount,
          currentPeriodStartsAt: subscription.currentPeriodStartsAt,
          currentPeriodEndsAt: subscription.currentPeriodEndsAt,
        },
        data: {
          status: "ACTIVE",
          campaignId: campaign.id,
          settledCycleCount: { increment: 1 },
          currentPeriodStartsAt: renewal.periodStartsAt,
          currentPeriodEndsAt: renewal.periodEndsAt,
        },
      });
      if (periodAdvance.count !== 1) {
        throw new Error("Subscription changed while the renewal was settling; retry the provider event");
      }

      const orderKey = renewalOrderIdempotencyKey(input);
      const orderNumber = `MBR-${sha256(`${input.tenantId}:${orderKey}`).slice(0, 16).toUpperCase()}`;
      const calculationJson = JSON.stringify({
        ...renewal.snapshot,
        campaignId: campaign.id,
        campaignCode: campaign.code,
        campaignRulesVersion: campaign.rulesVersion,
        campaignConfigHash: campaign.configChecksum,
        multiplierResolution: multiplierResolution.snapshot,
        planId: subscription.planId,
        subscriptionId: subscription.id,
      });
      const variant = subscription.plan.product.variants[0] ?? null;
      const order = await tx.order.create({
        data: {
          tenantId: input.tenantId,
          campaignId: campaign.id,
          entrantId: subscription.entrantId,
          userId: subscription.userId,
          orderNumber,
          channel: "SUBSCRIPTION",
          status: "CONFIRMED",
          paymentStatus: "CAPTURED",
          fulfillmentStatus: "FULFILLED",
          email: subscription.user.email,
          customerName: subscription.user.name,
          currency: renewal.currency,
          subtotalCents: renewal.priceCents,
          discountCents: 0,
          shippingCents: 0,
          taxCents: 0,
          totalCents: renewal.priceCents,
          entryTotal: renewal.awardedEntries,
          shippingAddressJson: JSON.stringify({
            kind: "NONE",
            reason: "DIGITAL_MEMBERSHIP_RENEWAL",
          }),
          provider: input.provider,
          providerPaymentId: input.providerPaymentId,
          idempotencyKey: orderKey,
          paidAt: input.occurredAt,
        },
      });
      const orderLine = await tx.orderLine.create({
        data: {
          orderId: order.id,
          productId: subscription.plan.productId,
          variantId: variant?.id ?? null,
          productTitle: subscription.plan.product.title,
          variantTitle: variant?.title ?? null,
          sku: variant?.sku ?? null,
          quantity: 1,
          unitPriceCents: renewal.priceCents,
          discountCents: 0,
          qualifyingCents: renewal.priceCents,
          entryMultiplier: renewal.band.multiplierNumerator * multiplierResolution.factor,
          entryMultiplierDenominator: renewal.band.multiplierDenominator,
          entries: renewal.awardedEntries,
          entryCalculationJson: calculationJson,
        },
      });
      const payment = await tx.payment.create({
        data: {
          orderId: order.id,
          provider: input.provider,
          providerEventId: input.providerEventId,
          providerPaymentId: input.providerPaymentId,
          status: "CAPTURED",
          amountCents: renewal.priceCents,
          currency: renewal.currency,
          payloadHash: input.payloadHash,
          idempotencyKey: namespacedHash(
            "subscription-payment",
            input.tenantId,
            input.subscriptionId,
            input.idempotencyKey,
          ),
          processedAt: input.occurredAt,
        },
      });
      const cycle = await tx.subscriptionCycle.create({
        data: {
          subscriptionId: subscription.id,
          orderId: order.id,
          cycleNumber: renewal.cycleNumber,
          status: "SETTLED",
          periodStartsAt: renewal.periodStartsAt,
          periodEndsAt: renewal.periodEndsAt,
          settledAt: input.occurredAt,
          baseEntries: renewal.baseEntries,
          multiplierNumerator: renewal.band.multiplierNumerator * multiplierResolution.factor,
          multiplierDenominator: renewal.band.multiplierDenominator,
        },
      });
      const entitlement = await tx.entryEntitlement.create({
        data: {
          tenantId: input.tenantId,
          entryAccountId: account.id,
          orderId: order.id,
          orderLineId: orderLine.id,
          originType: "SUBSCRIPTION_CYCLE",
          status: "POSTED",
          originalEntries: renewal.awardedEntries,
          calculationJson,
          campaignConfigHash: campaign.configChecksum,
          idempotencyKey: `subscription-cycle-entitlement:${cycle.id}`,
          effectiveAt: input.occurredAt,
        },
      });
      await tx.entryLedgerEvent.create({
        data: {
          tenantId: input.tenantId,
          entryAccountId: account.id,
          entitlementId: entitlement.id,
          kind: "GRANT",
          delta: renewal.awardedEntries,
          idempotencyKey: `subscription-cycle-ledger:${cycle.id}`,
          effectiveAt: input.occurredAt,
          actorType: "PAYMENT_PROVIDER",
          actorId: input.provider,
          reasonCode: "SUBSCRIPTION_RENEWAL_CAPTURED",
          metadataJson: JSON.stringify({
            subscriptionId: subscription.id,
            cycleId: cycle.id,
            cycleNumber: cycle.cycleNumber,
            orderNumber: order.orderNumber,
            providerEventId: input.providerEventId,
          }),
        },
      });
      await tx.entryAccount.update({
        where: { id: account.id },
        data: {
          balance: { increment: renewal.awardedEntries },
          version: { increment: 1 },
        },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: input.tenantId,
          actorType: "PAYMENT_PROVIDER",
          actorId: input.provider,
          action: "SUBSCRIPTION_RENEWAL_SETTLED",
          resourceType: "SubscriptionCycle",
          resourceId: cycle.id,
          metadataJson: JSON.stringify({
            subscriptionId: subscription.id,
            cycleNumber: cycle.cycleNumber,
            orderNumber: order.orderNumber,
            providerEventId: input.providerEventId,
            entries: renewal.awardedEntries.toString(),
          }),
        },
      });
      await tx.outboxEvent.create({
        data: {
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
      });

      return {
        subscriptionId: subscription.id,
        cycleId: cycle.id,
        cycleNumber: cycle.cycleNumber,
        orderId: order.id,
        orderNumber: order.orderNumber,
        paymentId: payment.id,
        campaignId: campaign.id,
        entries: renewal.awardedEntries,
        periodStartsAt: renewal.periodStartsAt,
        periodEndsAt: renewal.periodEndsAt,
        settledAt: input.occurredAt,
        idempotent: false,
      };
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const raced = await findPriorSettlement(db, input);
    if (!raced) throw error;
    return raced;
  }
}

/** Settles a capture through the same canonical service using demo identifiers. */
export async function settleDemoSubscriptionRenewal(rawInput: unknown): Promise<RenewalSettlementReceipt> {
  assertDemoMutationsEnabled();
  const input = settleDemoSubscriptionRenewalSchema.parse(rawInput);
  const providerEventId = demoProviderId(
    "demo_subscription_event",
    input.tenantId,
    input.subscriptionId,
    input.idempotencyKey,
  );
  const providerPaymentId = demoProviderId(
    "demo_subscription_payment",
    input.tenantId,
    input.subscriptionId,
    input.idempotencyKey,
  );
  const existingPayment = await db.payment.findUnique({
    where: {
      provider_providerEventId: {
        provider: "DEMO",
        providerEventId,
      },
    },
    select: {
      amountCents: true,
      currency: true,
      payloadHash: true,
      processedAt: true,
    },
  });
  const subscription = await db.subscription.findFirst({
    where: { id: input.subscriptionId, tenantId: input.tenantId },
    select: {
      plan: { select: { priceCents: true, currency: true } },
    },
  });
  if (!subscription && !existingPayment) throw new Error("Subscription not found");

  const capturedAmountCents = existingPayment?.amountCents ?? subscription!.plan.priceCents;
  const currency = existingPayment?.currency ?? subscription!.plan.currency;
  const occurredAt = existingPayment?.processedAt ?? input.occurredAt ?? new Date();
  const payloadHash = existingPayment?.payloadHash ?? sha256(JSON.stringify({
    provider: "DEMO",
    providerEventId,
    providerPaymentId,
    capturedAmountCents,
    currency,
  }));
  if (!occurredAt || !payloadHash) throw new Error("Existing demo payment is incomplete");

  return settleSubscriptionRenewal({
    tenantId: input.tenantId,
    subscriptionId: input.subscriptionId,
    provider: "DEMO",
    providerEventId,
    providerPaymentId,
    capturedAmountCents,
    currency,
    occurredAt,
    payloadHash,
    idempotencyKey: input.idempotencyKey,
  });
}

/** Marks an active subscription to end after its already-paid current period. */
export async function cancelSubscriptionAtPeriodEnd(rawInput: unknown): Promise<CancellationReceipt> {
  const input = cancelSubscriptionAtPeriodEndSchema.parse(rawInput);
  return db.$transaction(async (tx) => {
    const subscription = await tx.subscription.findFirst({
      where: { id: input.subscriptionId, tenantId: input.tenantId },
    });
    if (!subscription) throw new Error("Subscription not found");
    if (subscription.status === "CANCELLED") {
      return {
        subscriptionId: subscription.id,
        status: subscription.status,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        effectiveAt: subscription.currentPeriodEndsAt,
        cancelledAt: subscription.cancelledAt,
        finalized: true,
        idempotent: true,
      };
    }
    if (!renewableStatuses.includes(subscription.status as (typeof renewableStatuses)[number])) {
      throw new Error(`Subscription in status ${subscription.status} cannot be cancelled at period end`);
    }
    if (subscription.cancelAtPeriodEnd) {
      return {
        subscriptionId: subscription.id,
        status: subscription.status,
        cancelAtPeriodEnd: true,
        effectiveAt: subscription.currentPeriodEndsAt,
        cancelledAt: subscription.cancelledAt,
        finalized: false,
        idempotent: true,
      };
    }

    const update = await tx.subscription.updateMany({
      where: {
        id: subscription.id,
        tenantId: input.tenantId,
        status: { in: [...renewableStatuses] },
        cancelAtPeriodEnd: false,
      },
      data: { cancelAtPeriodEnd: true },
    });
    if (update.count !== 1) {
      throw new Error("Subscription changed while cancellation was being scheduled; retry the request");
    }
    await tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: "USER",
        actorId: subscription.userId,
        action: "SUBSCRIPTION_CANCELLATION_SCHEDULED",
        resourceType: "Subscription",
        resourceId: subscription.id,
        metadataJson: JSON.stringify({
          effectiveAt: subscription.currentPeriodEndsAt.toISOString(),
          requestFingerprint: sha256(input.idempotencyKey),
        }),
      },
    });
    await tx.outboxEvent.create({
      data: {
        tenantId: input.tenantId,
        aggregateType: "Subscription",
        aggregateId: subscription.id,
        kind: "SUBSCRIPTION_CANCELLATION_SCHEDULED",
        payloadJson: JSON.stringify({
          subscriptionId: subscription.id,
          effectiveAt: subscription.currentPeriodEndsAt.toISOString(),
        }),
        idempotencyKey: `subscription-cancellation-scheduled:${subscription.id}`,
      },
    });

    return {
      subscriptionId: subscription.id,
      status: subscription.status,
      cancelAtPeriodEnd: true,
      effectiveAt: subscription.currentPeriodEndsAt,
      cancelledAt: null,
      finalized: false,
      idempotent: false,
    };
  });
}

/**
 * Idempotent period-end worker operation. Calling it early reports the due date;
 * calling it at/after that instant transitions the scheduled record to CANCELLED.
 */
export async function finalizeSubscriptionCancellation(rawInput: unknown): Promise<CancellationReceipt> {
  const input = finalizeSubscriptionCancellationSchema.parse(rawInput);
  return db.$transaction(async (tx) => {
    const subscription = await tx.subscription.findFirst({
      where: { id: input.subscriptionId, tenantId: input.tenantId },
    });
    if (!subscription) throw new Error("Subscription not found");
    if (subscription.status === "CANCELLED") {
      return {
        subscriptionId: subscription.id,
        status: subscription.status,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        effectiveAt: subscription.currentPeriodEndsAt,
        cancelledAt: subscription.cancelledAt,
        finalized: true,
        idempotent: true,
      };
    }
    if (!subscription.cancelAtPeriodEnd) {
      throw new Error("Subscription is not scheduled to cancel at period end");
    }

    const now = new Date();
    if (now < subscription.currentPeriodEndsAt) {
      return {
        subscriptionId: subscription.id,
        status: subscription.status,
        cancelAtPeriodEnd: true,
        effectiveAt: subscription.currentPeriodEndsAt,
        cancelledAt: null,
        finalized: false,
        idempotent: true,
      };
    }
    const update = await tx.subscription.updateMany({
      where: {
        id: subscription.id,
        tenantId: input.tenantId,
        status: { in: [...renewableStatuses] },
        cancelAtPeriodEnd: true,
        currentPeriodEndsAt: subscription.currentPeriodEndsAt,
      },
      data: {
        status: "CANCELLED",
        cancelledAt: subscription.currentPeriodEndsAt,
      },
    });
    if (update.count !== 1) {
      throw new Error("Subscription changed while period-end cancellation was finalizing; retry the job");
    }
    await tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: "SYSTEM",
        action: "SUBSCRIPTION_CANCELLED_AT_PERIOD_END",
        resourceType: "Subscription",
        resourceId: subscription.id,
        metadataJson: JSON.stringify({
          effectiveAt: subscription.currentPeriodEndsAt.toISOString(),
        }),
      },
    });
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

    return {
      subscriptionId: subscription.id,
      status: "CANCELLED",
      cancelAtPeriodEnd: true,
      effectiveAt: subscription.currentPeriodEndsAt,
      cancelledAt: subscription.currentPeriodEndsAt,
      finalized: true,
      idempotent: false,
    };
  });
}
