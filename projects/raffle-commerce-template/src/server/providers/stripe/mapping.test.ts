import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import {
  prepareStripeOperation,
  STRIPE_REFUND_METADATA_CONTRACT,
  STRIPE_SUBSCRIPTION_METADATA_CONTRACT,
  type StripeInvoiceReader,
} from "./mapping";
import { STRIPE_CHECKOUT_METADATA_CONTRACT } from "./checkout-contract";

function invoicePayment(invoice: string): Stripe.InvoicePayment {
  return {
    id: "inpay_123",
    object: "invoice_payment",
    amount_paid: 2500,
    amount_requested: 2500,
    created: 1_783_857_600,
    currency: "usd",
    invoice,
    is_default: true,
    livemode: false,
    payment: { type: "payment_intent", payment_intent: "pi_renewal_123" },
    status: "paid",
    status_transitions: { paid_at: 1_783_857_610, canceled_at: null },
  } as Stripe.InvoicePayment;
}

function subscriptionInvoice(metadata: Record<string, string> = {
  giveaway_contract: STRIPE_SUBSCRIPTION_METADATA_CONTRACT,
  giveaway_tenant_id: "tenant_123",
  giveaway_subscription_id: "subscription_123",
  giveaway_subscription_fingerprint: "b".repeat(64),
  giveaway_price_id: "price_membership_123",
}): Stripe.Invoice {
  return {
    id: "in_renewal_123",
    object: "invoice",
    amount_paid: 2500,
    amount_remaining: 0,
    billing_reason: "subscription_cycle",
    created: 1_783_857_600,
    currency: "usd",
    customer: "cus_membership_123",
    lines: {
      object: "list",
      data: [{
        id: "il_membership_123",
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
      url: "/v1/invoices/in_renewal_123/lines",
    },
    parent: {
      type: "subscription_details",
      quote_details: null,
      subscription_details: {
        metadata,
        subscription: "sub_stripe_123",
      },
    },
    payments: undefined,
    status: "paid",
    status_transitions: {
      finalized_at: 1_783_857_600,
      marked_uncollectible_at: null,
      paid_at: 1_783_857_610,
      voided_at: null,
    },
  } as unknown as Stripe.Invoice;
}

function baseEvent<T extends string, TObject>(type: T, object: TObject) {
  return {
    id: `evt_${type.replaceAll(".", "_")}`,
    object: "event",
    account: undefined,
    api_version: "2026-06-24.dahlia",
    created: 1_783_857_620,
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
  };
}

function reader(invoice = subscriptionInvoice()): StripeInvoiceReader {
  return {
    async retrieveInvoice() {
      return invoice;
    },
    async listPaidInvoicePayments() {
      return [invoicePayment(invoice.id)];
    },
  };
}

function checkoutSession(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id: "cs_test_order_123",
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
    payment_intent: "pi_order_123",
    payment_status: "paid",
    status: "complete",
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

function subscriptionCheckoutSession(
  overrides: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session {
  return {
    id: "cs_membership_123",
    object: "checkout.session",
    client_reference_id: "subscription_123",
    customer: "cus_membership_123",
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
    subscription: "sub_stripe_123",
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

function subscriptionState(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: "sub_stripe_123",
    object: "subscription",
    cancel_at_period_end: false,
    customer: "cus_membership_123",
    ended_at: null,
    items: {
      object: "list",
      data: [{
        id: "si_membership_123",
        object: "subscription_item",
        current_period_start: 1_783_857_600,
        current_period_end: 1_786_536_000,
        price: {
          id: "price_membership_123",
          object: "price",
          active: true,
          currency: "usd",
          recurring: { interval: "month", interval_count: 1 },
          type: "recurring",
          unit_amount: 2500,
        },
        quantity: 1,
      }],
      has_more: false,
      url: "/v1/subscription_items?subscription=sub_stripe_123",
    },
    metadata: {
      giveaway_contract: STRIPE_SUBSCRIPTION_METADATA_CONTRACT,
      giveaway_tenant_id: "tenant_123",
      giveaway_subscription_id: "subscription_123",
      giveaway_subscription_fingerprint: "b".repeat(64),
      giveaway_price_id: "price_membership_123",
    },
    status: "active",
    ...overrides,
  } as unknown as Stripe.Subscription;
}

describe("Stripe one-time checkout mapping", () => {
  it("normalizes paid completion events to one canonical capture identity", async () => {
    const session = checkoutSession();
    const completed = await prepareStripeOperation(
      baseEvent("checkout.session.completed", session) as unknown as Stripe.CheckoutSessionCompletedEvent,
      reader(),
    );
    const asynchronous = await prepareStripeOperation(
      baseEvent("checkout.session.async_payment_succeeded", session) as unknown as Stripe.CheckoutSessionAsyncPaymentSucceededEvent,
      reader(),
    );
    expect(completed.kind).toBe("CHECKOUT_CAPTURE");
    expect(asynchronous.kind).toBe("CHECKOUT_CAPTURE");
    if (completed.kind !== "CHECKOUT_CAPTURE" || asynchronous.kind !== "CHECKOUT_CAPTURE") return;
    expect(completed.input).toMatchObject({
      tenantId: "tenant_123",
      orderId: "order_123",
      providerCheckoutId: "cs_test_order_123",
      providerPaymentId: "pi_order_123",
      providerEventId: "checkout:cs_test_order_123",
      orderFingerprint: "a".repeat(64),
      capturedAmountCents: 6100,
      currency: "USD",
      idempotencyKey: "stripe-checkout-capture:cs_test_order_123",
    });
    expect(asynchronous.input).toEqual(completed.input);
  });

  it("does not grant from an unpaid completion and maps expiry to cancellation", async () => {
    const unpaid = await prepareStripeOperation(
      baseEvent("checkout.session.completed", checkoutSession({ payment_status: "unpaid" })) as unknown as Stripe.CheckoutSessionCompletedEvent,
      reader(),
    );
    expect(unpaid).toEqual({ kind: "IGNORED", reason: "checkout_payment_status_unpaid" });

    const expired = await prepareStripeOperation(
      baseEvent("checkout.session.expired", checkoutSession({
        payment_intent: null,
        payment_status: "unpaid",
        status: "expired",
      })) as unknown as Stripe.CheckoutSessionExpiredEvent,
      reader(),
    );
    expect(expired).toMatchObject({
      kind: "CHECKOUT_CANCELLATION",
      tenantId: "tenant_123",
      orderId: "order_123",
      input: { reason: "SESSION_EXPIRED" },
    });
  });

  it("fails closed on missing metadata or a mismatched client reference", async () => {
    await expect(prepareStripeOperation(
      baseEvent("checkout.session.completed", checkoutSession({ metadata: {} })) as unknown as Stripe.CheckoutSessionCompletedEvent,
      reader(),
    )).rejects.toMatchObject({ code: "INVALID_METADATA" });
    await expect(prepareStripeOperation(
      baseEvent("checkout.session.completed", checkoutSession({ client_reference_id: "other_order" })) as unknown as Stripe.CheckoutSessionCompletedEvent,
      reader(),
    )).rejects.toMatchObject({ code: "INVALID_METADATA" });
  });
});

describe("Stripe subscription lifecycle mapping", () => {
  it("binds completed hosted enrollment and expires only unpaid enrollment sessions", async () => {
    const completedEvent = baseEvent(
      "checkout.session.completed",
      subscriptionCheckoutSession(),
    ) as unknown as Stripe.CheckoutSessionCompletedEvent;
    const completed = await prepareStripeOperation(
      completedEvent,
      reader(),
    );
    expect(completed).toMatchObject({
      kind: "SUBSCRIPTION_ENROLLMENT",
      tenantId: "tenant_123",
      subscriptionId: "subscription_123",
      providerSubscriptionId: "sub_stripe_123",
      input: {
        providerCheckoutId: "cs_membership_123",
        providerCustomerId: "cus_membership_123",
        subscriptionFingerprint: "b".repeat(64),
      },
    });

    const expired = await prepareStripeOperation(
      baseEvent("checkout.session.expired", subscriptionCheckoutSession({
        customer: null,
        payment_status: "unpaid",
        status: "expired",
        subscription: null,
      })) as unknown as Stripe.CheckoutSessionExpiredEvent,
      reader(),
    );
    expect(expired).toMatchObject({
      kind: "SUBSCRIPTION_ENROLLMENT_EXPIRED",
      input: { providerCheckoutId: "cs_membership_123" },
    });
  });

  it("maps failed invoices and authoritative subscription deletion without entries", async () => {
    const failedInvoice = {
      ...subscriptionInvoice(),
      amount_remaining: 2500,
      status: "open",
    } as Stripe.Invoice;
    const failed = await prepareStripeOperation(
      baseEvent("invoice.payment_failed", failedInvoice) as unknown as Stripe.InvoicePaymentFailedEvent,
      reader(failedInvoice),
    );
    expect(failed).toMatchObject({
      kind: "SUBSCRIPTION_INVOICE_FAILED",
      input: {
        subscriptionFingerprint: "b".repeat(64),
        providerSubscriptionId: "sub_stripe_123",
        providerCustomerId: "cus_membership_123",
        providerPriceId: "price_membership_123",
      },
    });

    const deleted = await prepareStripeOperation(
      baseEvent("customer.subscription.deleted", subscriptionState({
        status: "canceled",
        ended_at: 1_783_857_620,
      })) as unknown as Stripe.CustomerSubscriptionDeletedEvent,
      reader(),
    );
    expect(deleted).toMatchObject({
      kind: "SUBSCRIPTION_STATE",
      input: {
        providerStatus: "canceled",
        priceCents: 2500,
        currency: "USD",
        billingInterval: "MONTH",
        billingIntervalCount: 1,
      },
    });
  });
});

describe("Stripe recurring invoice mapping", () => {
  it("normalizes invoice.paid and invoice_payment.paid to one settlement key", async () => {
    const invoice = subscriptionInvoice();
    const paid = baseEvent("invoice.paid", invoice) as unknown as Stripe.InvoicePaidEvent;
    const invoicePaymentPaid = baseEvent(
      "invoice_payment.paid",
      invoicePayment(invoice.id),
    ) as unknown as Stripe.InvoicePaymentPaidEvent;

    const fromInvoice = await prepareStripeOperation(paid, reader(invoice));
    const fromPayment = await prepareStripeOperation(invoicePaymentPaid, reader(invoice));
    expect(fromInvoice.kind).toBe("SUBSCRIPTION_RENEWAL");
    expect(fromPayment.kind).toBe("SUBSCRIPTION_RENEWAL");
    if (fromInvoice.kind !== "SUBSCRIPTION_RENEWAL" || fromPayment.kind !== "SUBSCRIPTION_RENEWAL") return;

    expect(fromInvoice.providerSubscriptionId).toBe("sub_stripe_123");
    expect(fromInvoice.input).toMatchObject({
      tenantId: "tenant_123",
      subscriptionId: "subscription_123",
      subscriptionFingerprint: "b".repeat(64),
      providerSubscriptionId: "sub_stripe_123",
      providerCustomerId: "cus_membership_123",
      providerInvoiceId: "in_renewal_123",
      providerEventId: "invoice:in_renewal_123",
      providerPaymentId: "pi_renewal_123",
      providerPriceId: "price_membership_123",
      billingReason: "subscription_cycle",
      capturedAmountCents: 2500,
      currency: "USD",
      idempotencyKey: "stripe-invoice:in_renewal_123",
    });
    expect(fromPayment.input).toEqual(fromInvoice.input);
  });

  it("fails closed when immutable subscription metadata is missing", async () => {
    const invoice = subscriptionInvoice({ giveaway_tenant_id: "tenant_123" });
    const event = baseEvent("invoice.paid", invoice) as unknown as Stripe.InvoicePaidEvent;
    await expect(prepareStripeOperation(event, reader(invoice))).rejects.toMatchObject({
      code: "INVALID_METADATA",
    });
  });

  it("rejects non-cycle invoices and ambiguous multi-payment invoices", async () => {
    const invoice = { ...subscriptionInvoice(), billing_reason: "subscription_update" } as Stripe.Invoice;
    await expect(prepareStripeOperation(
      baseEvent("invoice.paid", invoice) as unknown as Stripe.InvoicePaidEvent,
      reader(invoice),
    )).rejects.toMatchObject({ code: "INVALID_EVENT_SHAPE" });

    const cycleInvoice = subscriptionInvoice();
    await expect(prepareStripeOperation(
      baseEvent("invoice.paid", cycleInvoice) as unknown as Stripe.InvoicePaidEvent,
      {
        ...reader(cycleInvoice),
        async listPaidInvoicePayments() {
          return [invoicePayment(cycleInvoice.id), { ...invoicePayment(cycleInvoice.id), id: "inpay_456" }];
        },
      },
    )).rejects.toMatchObject({ code: "INVALID_EVENT_SHAPE" });
  });
});

describe("Stripe refund mapping", () => {
  const refund = {
    id: "re_123",
    object: "refund",
    amount: 1200,
    created: 1_783_857_600,
    currency: "usd",
    metadata: {
      giveaway_contract: STRIPE_REFUND_METADATA_CONTRACT,
      giveaway_tenant_id: "tenant_123",
      giveaway_order_id: "order_123",
      giveaway_refund_id: "refund_123",
      giveaway_allocation_fingerprint: "a".repeat(64),
    },
    payment_intent: "pi_order_123",
    reason: "requested_by_customer",
    status: "succeeded",
  } as unknown as Stripe.Refund;

  it("maps a succeeded refund with the order metadata contract", async () => {
    const operation = await prepareStripeOperation(
      baseEvent("refund.created", refund) as unknown as Stripe.RefundCreatedEvent,
      reader(),
    );
    expect(operation).toMatchObject({
      kind: "REFUND_SETTLEMENT",
      tenantId: "tenant_123",
      orderId: "order_123",
      refundId: "refund_123",
      allocationFingerprint: "a".repeat(64),
      providerPaymentId: "pi_order_123",
      providerRefundId: "re_123",
      input: {
        provider: "STRIPE",
        amountCents: 1200,
        currency: "USD",
        idempotencyKey: "stripe-refund:re_123",
      },
    });
  });

  it.each([
    ["failed", "refund.failed"],
    ["canceled", "refund.updated"],
  ] as const)("maps terminal %s refunds for authoritative local failure settlement", async (status, eventType) => {
    const event = baseEvent(eventType, {
      ...refund,
      status,
      failure_reason: status === "failed" ? "insufficient_funds" : undefined,
    }) as unknown as Stripe.RefundFailedEvent | Stripe.RefundUpdatedEvent;
    const operation = await prepareStripeOperation(event, reader());
    expect(operation).toMatchObject({
      kind: "REFUND_FAILURE",
      tenantId: "tenant_123",
      orderId: "order_123",
      refundId: "refund_123",
      providerRefundId: "re_123",
      input: {
        providerEventId: event.id,
        providerStatus: status,
        amountCents: 1200,
        currency: "USD",
      },
    });
  });

  it("ignores pending refunds and rejects missing identity metadata", async () => {
    const pending = await prepareStripeOperation(
      baseEvent("refund.updated", { ...refund, status: "pending" }) as unknown as Stripe.RefundUpdatedEvent,
      reader(),
    );
    expect(pending).toEqual({ kind: "IGNORED", reason: "refund_status_pending" });

    await expect(prepareStripeOperation(
      baseEvent("refund.created", { ...refund, metadata: {} }) as unknown as Stripe.RefundCreatedEvent,
      reader(),
    )).rejects.toMatchObject({ code: "INVALID_METADATA" });
  });

  it("rejects connected-account events at the single-merchant boundary", async () => {
    const event = {
      ...baseEvent("refund.created", refund),
      account: "acct_connected",
    } as unknown as Stripe.RefundCreatedEvent;
    await expect(prepareStripeOperation(event, reader())).rejects.toMatchObject({
      code: "UNSUPPORTED_CONNECT_EVENT",
    });
  });
});
