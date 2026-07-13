import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import type {
  InsertWebhookDeliveryInput,
  WebhookDeliveryRecord,
  WebhookDeliveryRepository,
} from "./claim";
import {
  STRIPE_REFUND_METADATA_CONTRACT,
  STRIPE_SUBSCRIPTION_METADATA_CONTRACT,
} from "./mapping";
import { STRIPE_CHECKOUT_METADATA_CONTRACT } from "./checkout-contract";
import { processStripeWebhookEventWithDependencies } from "./processor-core";

class MemoryRepository implements WebhookDeliveryRepository {
  record: WebhookDeliveryRecord | null = null;

  async insertIfAbsent(input: InsertWebhookDeliveryInput) {
    if (this.record) return { inserted: false, record: { ...this.record } };
    this.record = {
      id: "delivery-1",
      ...input,
      status: "PROCESSING",
      attempts: 1,
      lastError: null,
      processedAt: null,
    };
    return { inserted: true, record: { ...this.record } };
  }

  async findById() {
    return this.record ? { ...this.record } : null;
  }

  async compareAndSwapClaim(input: { expectedStatus: string; expectedAttempts: number; claimedAt: Date }) {
    if (!this.record || this.record.status !== input.expectedStatus || this.record.attempts !== input.expectedAttempts) return false;
    this.record.status = "PROCESSING";
    this.record.attempts += 1;
    this.record.receivedAt = input.claimedAt;
    return true;
  }

  async markProcessed(_id: string, processedAt: Date) {
    if (!this.record || this.record.status !== "PROCESSING") return false;
    this.record.status = "PROCESSED";
    this.record.processedAt = processedAt;
    return true;
  }

  async markFailed(_id: string, message: string) {
    if (!this.record || this.record.status !== "PROCESSING") return false;
    this.record.status = "FAILED";
    this.record.lastError = message;
    return true;
  }
}

function renewalFixture() {
  const invoice = {
    id: "in_processor_123",
    object: "invoice",
    amount_paid: 2500,
    amount_remaining: 0,
    billing_reason: "subscription_cycle",
    created: 1_783_857_600,
    currency: "usd",
    customer: "cus_processor_123",
    lines: {
      object: "list",
      data: [{
        id: "il_processor_123",
        object: "line_item",
        amount: 2500,
        currency: "usd",
        parent: {
          type: "subscription_item_details",
          invoice_item_details: null,
          subscription_item_details: { proration: false },
        },
        period: { start: 1_783_857_600, end: 1_786_536_000 },
        pricing: {
          type: "price_details",
          price_details: { price: "price_membership_123", product: "prod_membership_123" },
        },
        quantity: 1,
        subscription: "sub_stripe_123",
      }],
      has_more: false,
      url: "/v1/invoices/in_processor_123/lines",
    },
    parent: {
      type: "subscription_details",
      quote_details: null,
      subscription_details: {
        metadata: {
          giveaway_contract: STRIPE_SUBSCRIPTION_METADATA_CONTRACT,
          giveaway_tenant_id: "tenant_123",
          giveaway_subscription_id: "subscription_123",
          giveaway_subscription_fingerprint: "b".repeat(64),
          giveaway_price_id: "price_membership_123",
        },
        subscription: "sub_stripe_123",
      },
    },
    status: "paid",
    status_transitions: { paid_at: 1_783_857_610 },
  } as unknown as Stripe.Invoice;
  const payment = {
    id: "inpay_processor_123",
    object: "invoice_payment",
    amount_paid: 2500,
    amount_requested: 2500,
    created: 1_783_857_600,
    currency: "usd",
    invoice: invoice.id,
    is_default: true,
    livemode: false,
    payment: { type: "payment_intent", payment_intent: "pi_processor_123" },
    status: "paid",
    status_transitions: { paid_at: 1_783_857_610, canceled_at: null },
  } as Stripe.InvoicePayment;
  const event = {
    id: "evt_processor_123",
    object: "event",
    api_version: "2026-06-24.dahlia",
    created: 1_783_857_620,
    data: { object: invoice },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "invoice.paid",
  } as unknown as Stripe.InvoicePaidEvent;
  return { invoice, payment, event };
}

describe("Stripe webhook processor", () => {
  it("settles once, records completion, and short-circuits an exact redelivery", async () => {
    const fixture = renewalFixture();
    const repository = new MemoryRepository();
    const settleRenewal = vi.fn(async () => ({ cycleId: "cycle-1" }));
    const dependencies = {
      reader: {
        async retrieveInvoice() { return fixture.invoice; },
        async listPaidInvoicePayments() { return [fixture.payment]; },
      },
      repository,
      verifySubscriptionIdentity: async () => true,
      verifyRefundIdentity: async () => true,
      verifyCheckoutIdentity: async () => true,
      settleRenewal,
      bindSubscription: async () => undefined,
      expireSubscription: async () => undefined,
      failSubscription: async () => undefined,
      updateSubscriptionState: async () => undefined,
      settleRefund: async () => undefined,
      failRefund: async () => undefined,
      settleCheckout: async () => undefined,
      cancelCheckout: async () => undefined,
      now: () => new Date("2026-07-12T12:00:00.000Z"),
    };
    const rawBody = new TextEncoder().encode("signed-event-payload");

    await expect(processStripeWebhookEventWithDependencies(fixture.event, rawBody, dependencies)).resolves.toMatchObject({
      status: "PROCESSED",
      operation: "SUBSCRIPTION_RENEWAL",
    });
    await expect(processStripeWebhookEventWithDependencies(fixture.event, rawBody, dependencies)).resolves.toMatchObject({
      status: "DUPLICATE",
    });
    expect(settleRenewal).toHaveBeenCalledTimes(1);
    expect(repository.record).toMatchObject({ status: "PROCESSED", attempts: 1, lastError: null });
  });

  it("routes hosted subscription completion through authoritative binding", async () => {
    const session = {
      id: "cs_membership_processor",
      object: "checkout.session",
      client_reference_id: "subscription_123",
      customer: "cus_membership_processor",
      livemode: false,
      metadata: {
        giveaway_contract: STRIPE_SUBSCRIPTION_METADATA_CONTRACT,
        giveaway_tenant_id: "tenant_123",
        giveaway_subscription_id: "subscription_123",
        giveaway_subscription_fingerprint: "b".repeat(64),
        giveaway_price_id: "price_membership_123",
      },
      mode: "subscription",
      payment_status: "paid",
      status: "complete",
      subscription: "sub_membership_processor",
    } as unknown as Stripe.Checkout.Session;
    const event = {
      id: "evt_membership_checkout_processor",
      object: "event",
      api_version: "2026-06-24.dahlia",
      created: 1_783_857_620,
      data: { object: session },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "checkout.session.completed",
    } as unknown as Stripe.CheckoutSessionCompletedEvent;
    const bindSubscription = vi.fn(async () => ({ subscriptionId: "subscription_123" }));
    const verifySubscriptionIdentity = vi.fn(async () => true);
    await expect(processStripeWebhookEventWithDependencies(
      event,
      new TextEncoder().encode("signed-membership-checkout"),
      {
        reader: {
          async retrieveInvoice() { throw new Error("not used"); },
          async listPaidInvoicePayments() { return []; },
        },
        repository: new MemoryRepository(),
        verifySubscriptionIdentity,
        verifyRefundIdentity: async () => true,
        verifyCheckoutIdentity: async () => true,
        settleRenewal: async () => undefined,
        bindSubscription,
        expireSubscription: async () => undefined,
        failSubscription: async () => undefined,
        updateSubscriptionState: async () => undefined,
        settleRefund: async () => undefined,
        failRefund: async () => undefined,
        settleCheckout: async () => undefined,
        cancelCheckout: async () => undefined,
        now: () => new Date("2026-07-12T12:00:00.000Z"),
      },
    )).resolves.toMatchObject({ status: "PROCESSED", operation: "SUBSCRIPTION_ENROLLMENT" });
    expect(verifySubscriptionIdentity).toHaveBeenCalledWith(expect.objectContaining({
      subscriptionId: "subscription_123",
      providerCheckoutId: "cs_membership_processor",
      subscriptionFingerprint: "b".repeat(64),
    }));
    expect(bindSubscription).toHaveBeenCalledTimes(1);
  });

  it("records a failed claim when authoritative subscription identity mismatches", async () => {
    const fixture = renewalFixture();
    const repository = new MemoryRepository();
    await expect(processStripeWebhookEventWithDependencies(
      fixture.event,
      new TextEncoder().encode("another-signed-payload"),
      {
        reader: {
          async retrieveInvoice() { return fixture.invoice; },
          async listPaidInvoicePayments() { return [fixture.payment]; },
        },
        repository,
        verifySubscriptionIdentity: async () => false,
        verifyRefundIdentity: async () => true,
        verifyCheckoutIdentity: async () => true,
        settleRenewal: async () => undefined,
        bindSubscription: async () => undefined,
        expireSubscription: async () => undefined,
        failSubscription: async () => undefined,
        updateSubscriptionState: async () => undefined,
        settleRefund: async () => undefined,
        failRefund: async () => undefined,
        settleCheckout: async () => undefined,
        cancelCheckout: async () => undefined,
        now: () => new Date("2026-07-12T12:00:00.000Z"),
      },
    )).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(repository.record).toMatchObject({
      status: "FAILED",
      lastError: expect.stringContaining("IDENTITY_MISMATCH"),
    });
  });

  it("routes terminal refund failures through the authoritative failure service", async () => {
    const refund = {
      id: "re_failed_processor",
      object: "refund",
      amount: 1200,
      created: 1_783_857_600,
      currency: "usd",
      failure_reason: "insufficient_funds",
      metadata: {
        giveaway_contract: STRIPE_REFUND_METADATA_CONTRACT,
        giveaway_tenant_id: "tenant_123",
        giveaway_order_id: "order_123",
        giveaway_refund_id: "refund_123",
        giveaway_allocation_fingerprint: "a".repeat(64),
      },
      payment_intent: "pi_123",
      reason: "requested_by_customer",
      status: "failed",
    } as unknown as Stripe.Refund;
    const event = {
      id: "evt_refund_failed_processor",
      object: "event",
      api_version: "2026-06-24.dahlia",
      created: 1_783_857_620,
      data: { object: refund },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "refund.failed",
    } as unknown as Stripe.RefundFailedEvent;
    const failRefund = vi.fn(async () => undefined);
    const settleRefund = vi.fn(async () => undefined);
    const verifyRefundIdentity = vi.fn(async () => true);
    await expect(processStripeWebhookEventWithDependencies(
      event,
      new TextEncoder().encode("signed-refund-failure"),
      {
        reader: {
          async retrieveInvoice() { throw new Error("not used"); },
          async listPaidInvoicePayments() { return []; },
        },
        repository: new MemoryRepository(),
        verifySubscriptionIdentity: async () => true,
        verifyRefundIdentity,
        verifyCheckoutIdentity: async () => true,
        settleRenewal: async () => undefined,
        bindSubscription: async () => undefined,
        expireSubscription: async () => undefined,
        failSubscription: async () => undefined,
        updateSubscriptionState: async () => undefined,
        settleRefund,
        failRefund,
        settleCheckout: async () => undefined,
        cancelCheckout: async () => undefined,
        now: () => new Date("2026-07-12T12:00:00.000Z"),
      },
    )).resolves.toMatchObject({ status: "PROCESSED", operation: "REFUND_FAILURE" });
    expect(verifyRefundIdentity).toHaveBeenCalledWith(expect.objectContaining({
      refundId: "refund_123",
      providerRefundId: "re_failed_processor",
    }));
    expect(failRefund).toHaveBeenCalledWith(expect.objectContaining({
      providerStatus: "failed",
      failureReason: "Stripe refund failed: insufficient_funds",
    }));
    expect(settleRefund).not.toHaveBeenCalled();
  });

  it("settles one-time checkout only once through the claimed delivery", async () => {
    const session = {
      id: "cs_processor_order",
      object: "checkout.session",
      amount_total: 6100,
      client_reference_id: "order_123",
      created: 1_783_857_600,
      currency: "usd",
      livemode: false,
      metadata: {
        giveaway_contract: STRIPE_CHECKOUT_METADATA_CONTRACT,
        giveaway_tenant_id: "tenant_123",
        giveaway_order_id: "order_123",
        giveaway_order_fingerprint: "a".repeat(64),
      },
      mode: "payment",
      payment_intent: "pi_processor_order",
      payment_status: "paid",
      status: "complete",
    } as unknown as Stripe.Checkout.Session;
    const event = {
      id: "evt_checkout_processor",
      object: "event",
      api_version: "2026-06-24.dahlia",
      created: 1_783_857_620,
      data: { object: session },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "checkout.session.completed",
    } as unknown as Stripe.CheckoutSessionCompletedEvent;
    const repository = new MemoryRepository();
    const settleCheckout = vi.fn(async () => ({ orderId: "order_123" }));
    const dependencies = {
      reader: {
        async retrieveInvoice() { throw new Error("not used"); },
        async listPaidInvoicePayments() { return []; },
      },
      repository,
      verifySubscriptionIdentity: async () => true,
      verifyRefundIdentity: async () => true,
      verifyCheckoutIdentity: async () => true,
      settleRenewal: async () => undefined,
      bindSubscription: async () => undefined,
      expireSubscription: async () => undefined,
      failSubscription: async () => undefined,
      updateSubscriptionState: async () => undefined,
      settleRefund: async () => undefined,
      failRefund: async () => undefined,
      settleCheckout,
      cancelCheckout: async () => undefined,
      now: () => new Date("2026-07-12T12:00:00.000Z"),
    };
    const rawBody = new TextEncoder().encode("signed-checkout-event");
    await expect(processStripeWebhookEventWithDependencies(event, rawBody, dependencies))
      .resolves.toMatchObject({ status: "PROCESSED", operation: "CHECKOUT_CAPTURE" });
    await expect(processStripeWebhookEventWithDependencies(event, rawBody, dependencies))
      .resolves.toMatchObject({ status: "DUPLICATE" });
    expect(settleCheckout).toHaveBeenCalledTimes(1);
  });

  it("routes an expired Checkout Session to cancellation without capture", async () => {
    const session = {
      id: "cs_expired_processor",
      object: "checkout.session",
      amount_total: 6100,
      client_reference_id: "order_123",
      created: 1_783_857_600,
      currency: "usd",
      livemode: false,
      metadata: {
        giveaway_contract: STRIPE_CHECKOUT_METADATA_CONTRACT,
        giveaway_tenant_id: "tenant_123",
        giveaway_order_id: "order_123",
        giveaway_order_fingerprint: "a".repeat(64),
      },
      mode: "payment",
      payment_intent: null,
      payment_status: "unpaid",
      status: "expired",
    } as unknown as Stripe.Checkout.Session;
    const event = {
      id: "evt_checkout_expired_processor",
      object: "event",
      api_version: "2026-06-24.dahlia",
      created: 1_783_857_620,
      data: { object: session },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "checkout.session.expired",
    } as unknown as Stripe.CheckoutSessionExpiredEvent;
    const cancelCheckout = vi.fn(async () => ({ status: "CANCELLED" }));
    const settleCheckout = vi.fn();
    await expect(processStripeWebhookEventWithDependencies(
      event,
      new TextEncoder().encode("signed-expiry-event"),
      {
        reader: {
          async retrieveInvoice() { throw new Error("not used"); },
          async listPaidInvoicePayments() { return []; },
        },
        repository: new MemoryRepository(),
        verifySubscriptionIdentity: async () => true,
        verifyRefundIdentity: async () => true,
        verifyCheckoutIdentity: async () => true,
        settleRenewal: async () => undefined,
        bindSubscription: async () => undefined,
        expireSubscription: async () => undefined,
        failSubscription: async () => undefined,
        updateSubscriptionState: async () => undefined,
        settleRefund: async () => undefined,
        failRefund: async () => undefined,
        settleCheckout,
        cancelCheckout,
        now: () => new Date("2026-07-12T12:00:00.000Z"),
      },
    )).resolves.toMatchObject({ status: "PROCESSED", operation: "CHECKOUT_CANCELLATION" });
    expect(cancelCheckout).toHaveBeenCalledTimes(1);
    expect(settleCheckout).not.toHaveBeenCalled();
  });
});
