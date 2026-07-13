import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { claimWebhookDelivery, type WebhookDeliveryRepository } from "./claim";
import { StripeBoundaryError, asStripeBoundaryError } from "./errors";
import {
  prepareStripeOperation,
  type PreparedStripeOperation,
  type StripeInvoiceReader,
} from "./mapping";

export type ProcessorDependencies = {
  reader: StripeInvoiceReader;
  repository: WebhookDeliveryRepository;
  verifySubscriptionIdentity(input: {
    tenantId: string;
    subscriptionId: string;
    subscriptionFingerprint: string;
    providerSubscriptionId?: string;
    providerCheckoutId?: string;
    providerPriceId?: string;
  }): Promise<boolean>;
  verifyRefundIdentity(input: {
    tenantId: string;
    orderId: string;
    refundId: string;
    allocationFingerprint: string;
    providerPaymentId: string;
    providerRefundId: string;
    amountCents: number;
    currency: string;
  }): Promise<boolean>;
  verifyCheckoutIdentity(input: {
    tenantId: string;
    orderId: string;
    providerCheckoutId: string;
    orderFingerprint: string;
  }): Promise<boolean>;
  settleRenewal(input: unknown): Promise<unknown>;
  bindSubscription(input: unknown): Promise<unknown>;
  expireSubscription(input: unknown): Promise<unknown>;
  failSubscription(input: unknown): Promise<unknown>;
  updateSubscriptionState(input: unknown): Promise<unknown>;
  settleRefund(input: unknown): Promise<unknown>;
  failRefund(input: unknown): Promise<unknown>;
  settleCheckout(input: unknown): Promise<unknown>;
  cancelCheckout(input: unknown): Promise<unknown>;
  now(): Date;
};

export type StripeWebhookProcessingResult = {
  status: "PROCESSED" | "DUPLICATE" | "IGNORED";
  eventId: string;
  operation?: Exclude<PreparedStripeOperation["kind"], "IGNORED">;
  reason?: string;
};

function payloadHash(rawBody: Uint8Array) {
  return createHash("sha256").update(rawBody).digest("hex");
}

async function executeOperation(
  operation: PreparedStripeOperation,
  dependencies: ProcessorDependencies,
) {
  if (operation.kind === "IGNORED") return;
  if (
    operation.kind === "SUBSCRIPTION_RENEWAL"
    || operation.kind === "SUBSCRIPTION_ENROLLMENT"
    || operation.kind === "SUBSCRIPTION_ENROLLMENT_EXPIRED"
    || operation.kind === "SUBSCRIPTION_INVOICE_FAILED"
    || operation.kind === "SUBSCRIPTION_STATE"
  ) {
    const identityMatches = await dependencies.verifySubscriptionIdentity({
      tenantId: operation.tenantId,
      subscriptionId: operation.subscriptionId,
      subscriptionFingerprint: operation.input.subscriptionFingerprint,
      ...(operation.providerSubscriptionId
        ? { providerSubscriptionId: operation.providerSubscriptionId }
        : {}),
      ...(operation.kind === "SUBSCRIPTION_ENROLLMENT"
        || operation.kind === "SUBSCRIPTION_ENROLLMENT_EXPIRED"
        ? { providerCheckoutId: operation.input.providerCheckoutId }
        : {}),
      providerPriceId: operation.input.providerPriceId,
    });
    if (!identityMatches) {
      throw new StripeBoundaryError(
        "IDENTITY_MISMATCH",
        "Stripe subscription metadata does not match an authoritative subscription",
        { httpStatus: 422 },
      );
    }
    if (operation.kind === "SUBSCRIPTION_RENEWAL") {
      await dependencies.settleRenewal(operation.input);
    } else if (operation.kind === "SUBSCRIPTION_ENROLLMENT") {
      await dependencies.bindSubscription(operation.input);
    } else if (operation.kind === "SUBSCRIPTION_ENROLLMENT_EXPIRED") {
      await dependencies.expireSubscription(operation.input);
    } else if (operation.kind === "SUBSCRIPTION_INVOICE_FAILED") {
      await dependencies.failSubscription(operation.input);
    } else {
      await dependencies.updateSubscriptionState(operation.input);
    }
    return;
  }

  if (operation.kind === "CHECKOUT_CAPTURE" || operation.kind === "CHECKOUT_CANCELLATION") {
    const identityMatches = await dependencies.verifyCheckoutIdentity({
      tenantId: operation.tenantId,
      orderId: operation.orderId,
      providerCheckoutId: operation.providerCheckoutId,
      orderFingerprint: operation.orderFingerprint,
    });
    if (!identityMatches) {
      throw new StripeBoundaryError(
        "IDENTITY_MISMATCH",
        "Stripe Checkout metadata does not match an authoritative prepared order",
        { httpStatus: 422 },
      );
    }
    if (operation.kind === "CHECKOUT_CAPTURE") {
      await dependencies.settleCheckout(operation.input);
    } else {
      await dependencies.cancelCheckout(operation.input);
    }
    return;
  }

  if (operation.kind !== "REFUND_SETTLEMENT" && operation.kind !== "REFUND_FAILURE") return;
  const identityMatches = await dependencies.verifyRefundIdentity({
    tenantId: operation.tenantId,
    orderId: operation.orderId,
    refundId: operation.refundId,
    allocationFingerprint: operation.allocationFingerprint,
    providerPaymentId: operation.providerPaymentId,
    providerRefundId: operation.providerRefundId,
    amountCents: operation.input.amountCents,
    currency: operation.input.currency,
  });
  if (!identityMatches) {
    throw new StripeBoundaryError(
      "IDENTITY_MISMATCH",
      "Stripe refund metadata does not match one authoritative order payment",
      { httpStatus: 422 },
    );
  }
  if (operation.kind === "REFUND_SETTLEMENT") {
    await dependencies.settleRefund(operation.input);
  } else {
    await dependencies.failRefund(operation.input);
  }
}

export async function processStripeWebhookEventWithDependencies(
  event: Stripe.Event,
  rawBody: Uint8Array,
  dependencies: ProcessorDependencies,
): Promise<StripeWebhookProcessingResult> {
  const operation = await prepareStripeOperation(event, dependencies.reader);
  if (operation.kind === "IGNORED") {
    return { status: "IGNORED", eventId: event.id, reason: operation.reason };
  }

  const receivedAt = dependencies.now();
  const claim = await claimWebhookDelivery(
    dependencies.repository,
    {
      tenantId: operation.tenantId,
      provider: "STRIPE",
      providerEventId: event.id,
      eventType: event.type,
      payloadHash: payloadHash(rawBody),
      receivedAt,
    },
    { now: receivedAt },
  );
  if (claim.status === "DUPLICATE") {
    return { status: "DUPLICATE", eventId: event.id, operation: operation.kind };
  }
  if (claim.status === "IN_PROGRESS") {
    throw new StripeBoundaryError(
      "DELIVERY_IN_PROGRESS",
      "A matching Stripe delivery is already processing",
      { httpStatus: 409, retryable: true },
    );
  }

  try {
    await executeOperation(operation, dependencies);
    const completed = await dependencies.repository.markProcessed(
      claim.recordId,
      dependencies.now(),
    );
    if (!completed) {
      throw new StripeBoundaryError(
        "PROCESSING_FAILED",
        "Stripe delivery lost its processing claim before completion",
        { httpStatus: 500, retryable: true },
      );
    }
    return { status: "PROCESSED", eventId: event.id, operation: operation.kind };
  } catch (error) {
    const boundaryError = asStripeBoundaryError(error);
    await dependencies.repository.markFailed(
      claim.recordId,
      `${boundaryError.code}: ${boundaryError.message}`,
    );
    throw boundaryError;
  }
}
