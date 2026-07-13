import "server-only";

import type Stripe from "stripe";
import { db } from "@/server/db";
import {
  cancelStripeCheckout,
  settleStripeCheckoutCapture,
} from "@/server/commerce/stripe-checkout";
import {
  applyStripeSubscriptionState,
  bindStripeSubscriptionEnrollment,
  expireStripeSubscriptionEnrollment,
  failStripeSubscriptionInvoice,
  settleStripeSubscriptionInvoice,
} from "@/server/subscriptions/stripe-service";
import {
  failStripeRefund,
  settleRefund as settleCanonicalRefund,
} from "@/server/refunds/service";
import { createStripeInvoiceReader } from "./client";
import {
  processStripeWebhookEventWithDependencies,
  type ProcessorDependencies,
  type StripeWebhookProcessingResult,
} from "./processor-core";
import { prismaWebhookDeliveryRepository } from "./store";

export type { ProcessorDependencies, StripeWebhookProcessingResult } from "./processor-core";

function dependenciesWithDefaults(overrides: Partial<ProcessorDependencies>): ProcessorDependencies {
  return {
    reader: overrides.reader ?? createStripeInvoiceReader(),
    repository: overrides.repository ?? prismaWebhookDeliveryRepository,
    verifySubscriptionIdentity: overrides.verifySubscriptionIdentity ?? (async (input) => {
      const subscription = await db.subscription.findFirst({
        where: {
          id: input.subscriptionId,
          tenantId: input.tenantId,
          provider: "STRIPE",
          enrollmentFingerprint: input.subscriptionFingerprint,
          ...(input.providerPriceId ? { providerPriceId: input.providerPriceId } : {}),
          ...(input.providerCheckoutId ? {
            OR: [{ providerCheckoutId: null }, { providerCheckoutId: input.providerCheckoutId }],
          } : input.providerSubscriptionId ? {
            OR: [{ providerSubscriptionId: null }, { providerSubscriptionId: input.providerSubscriptionId }],
          } : {}),
        },
        select: { id: true },
      });
      return Boolean(subscription);
    }),
    verifyRefundIdentity: overrides.verifyRefundIdentity ?? (async (input) => {
      const intents = await db.refund.findMany({
        where: {
          id: input.refundId,
          tenantId: input.tenantId,
          orderId: input.orderId,
          amountCents: input.amountCents,
          currency: input.currency,
          allocationFingerprint: input.allocationFingerprint,
          status: { in: ["PENDING", "PROCESSING", "COMPLETED", "FAILED"] },
          OR: [{ providerRefundId: null }, { providerRefundId: input.providerRefundId }],
          payment: { provider: "STRIPE", providerPaymentId: input.providerPaymentId },
          order: {
            id: input.orderId,
            tenantId: input.tenantId,
            provider: "STRIPE",
            currency: input.currency,
          },
        },
        select: { id: true },
        take: 2,
      });
      return intents.length === 1;
    }),
    verifyCheckoutIdentity: overrides.verifyCheckoutIdentity ?? (async (input) => {
      const orders = await db.order.findMany({
        where: {
          id: input.orderId,
          tenantId: input.tenantId,
          provider: "STRIPE",
          providerCheckoutId: input.providerCheckoutId,
          checkoutFingerprint: input.orderFingerprint,
        },
        select: { id: true },
        take: 2,
      });
      return orders.length === 1;
    }),
    settleRenewal: overrides.settleRenewal ?? settleStripeSubscriptionInvoice,
    bindSubscription: overrides.bindSubscription ?? bindStripeSubscriptionEnrollment,
    expireSubscription: overrides.expireSubscription ?? expireStripeSubscriptionEnrollment,
    failSubscription: overrides.failSubscription ?? failStripeSubscriptionInvoice,
    updateSubscriptionState: overrides.updateSubscriptionState ?? applyStripeSubscriptionState,
    settleRefund: overrides.settleRefund ?? settleCanonicalRefund,
    failRefund: overrides.failRefund ?? failStripeRefund,
    settleCheckout: overrides.settleCheckout ?? settleStripeCheckoutCapture,
    cancelCheckout: overrides.cancelCheckout ?? cancelStripeCheckout,
    now: overrides.now ?? (() => new Date()),
  };
}

export async function processStripeWebhookEvent(
  event: Stripe.Event,
  rawBody: Uint8Array,
  overrides: Partial<ProcessorDependencies> = {},
): Promise<StripeWebhookProcessingResult> {
  return processStripeWebhookEventWithDependencies(
    event,
    rawBody,
    dependenciesWithDefaults(overrides),
  );
}
