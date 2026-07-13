import { createHash } from "node:crypto";
import type Stripe from "stripe";
import {
  STRIPE_CHECKOUT_METADATA_CONTRACT,
  stripeCheckoutMetadataSchema,
} from "./checkout-contract";
import {
  STRIPE_SUBSCRIPTION_METADATA_CONTRACT,
  stripeSubscriptionMetadataSchema,
} from "./subscription-contract";
import {
  stripeRefundMetadataSchema,
} from "./refund-contract";
import { StripeBoundaryError } from "./errors";

export { STRIPE_SUBSCRIPTION_METADATA_CONTRACT } from "./subscription-contract";
export { STRIPE_REFUND_METADATA_CONTRACT } from "./refund-contract";

export interface StripeInvoiceReader {
  retrieveInvoice(invoiceId: string): Promise<Stripe.Invoice>;
  listPaidInvoicePayments(invoiceId: string): Promise<Stripe.InvoicePayment[]>;
  listInvoiceLineItems?(invoiceId: string): Promise<Stripe.InvoiceLineItem[]>;
}

export type StripeRenewalOperation = {
  kind: "SUBSCRIPTION_RENEWAL";
  tenantId: string;
  subscriptionId: string;
  providerSubscriptionId: string;
  invoiceId: string;
  input: {
    tenantId: string;
    subscriptionId: string;
    subscriptionFingerprint: string;
    providerSubscriptionId: string;
    providerCustomerId: string;
    providerPriceId: string;
    providerInvoiceId: string;
    providerEventId: string;
    providerPaymentId: string;
    billingReason: "subscription_create" | "subscription_cycle";
    capturedAmountCents: number;
    currency: string;
    periodStartsAt: Date;
    periodEndsAt: Date;
    occurredAt: Date;
    payloadHash: string;
    idempotencyKey: string;
  };
};

export type StripeSubscriptionEnrollmentOperation = {
  kind: "SUBSCRIPTION_ENROLLMENT";
  tenantId: string;
  subscriptionId: string;
  providerSubscriptionId: string;
  input: {
    tenantId: string;
    subscriptionId: string;
    subscriptionFingerprint: string;
    providerCheckoutId: string;
    providerPriceId: string;
    providerSubscriptionId: string;
    providerCustomerId: string;
    providerEventId: string;
    occurredAt: Date;
  };
};

export type StripeSubscriptionEnrollmentExpiredOperation = {
  kind: "SUBSCRIPTION_ENROLLMENT_EXPIRED";
  tenantId: string;
  subscriptionId: string;
  providerSubscriptionId: "";
  input: {
    tenantId: string;
    subscriptionId: string;
    subscriptionFingerprint: string;
    providerCheckoutId: string;
    providerPriceId: string;
    providerEventId: string;
    occurredAt: Date;
  };
};

export type StripeSubscriptionInvoiceFailedOperation = {
  kind: "SUBSCRIPTION_INVOICE_FAILED";
  tenantId: string;
  subscriptionId: string;
  providerSubscriptionId: string;
  input: {
    tenantId: string;
    subscriptionId: string;
    subscriptionFingerprint: string;
    providerSubscriptionId: string;
    providerCustomerId: string;
    providerPriceId: string;
    providerInvoiceId: string;
    providerEventId: string;
    occurredAt: Date;
  };
};

export type StripeSubscriptionStateOperation = {
  kind: "SUBSCRIPTION_STATE";
  tenantId: string;
  subscriptionId: string;
  providerSubscriptionId: string;
  input: {
    tenantId: string;
    subscriptionId: string;
    subscriptionFingerprint: string;
    providerSubscriptionId: string;
    providerCustomerId: string;
    providerPriceId: string;
    priceCents: number;
    currency: string;
    billingInterval: "DAY" | "WEEK" | "MONTH" | "YEAR";
    billingIntervalCount: number;
    providerEventId: string;
    providerStatus: Stripe.Subscription.Status;
    cancelAtPeriodEnd: boolean;
    periodStartsAt: Date;
    periodEndsAt: Date;
    endedAt: Date | null;
    occurredAt: Date;
  };
};

export type StripeRefundOperation = {
  kind: "REFUND_SETTLEMENT";
  tenantId: string;
  orderId: string;
  refundId: string;
  allocationFingerprint: string;
  providerPaymentId: string;
  providerRefundId: string;
  input: {
    tenantId: string;
    orderId: string;
    refundId: string;
    allocationFingerprint: string;
    provider: "STRIPE";
    providerPaymentId: string;
    providerRefundId: string;
    amountCents: number;
    currency: string;
    reason: string;
    actorType: "PAYMENT_PROVIDER";
    actorId: "STRIPE";
    occurredAt: Date;
    idempotencyKey: string;
  };
};

export type StripeRefundFailureOperation = {
  kind: "REFUND_FAILURE";
  tenantId: string;
  orderId: string;
  refundId: string;
  allocationFingerprint: string;
  providerPaymentId: string;
  providerRefundId: string;
  input: {
    tenantId: string;
    orderId: string;
    refundId: string;
    allocationFingerprint: string;
    providerPaymentId: string;
    providerRefundId: string;
    providerEventId: string;
    amountCents: number;
    currency: string;
    providerStatus: "failed" | "canceled";
    failureReason: string;
    occurredAt: Date;
  };
};

export type StripeCheckoutCaptureOperation = {
  kind: "CHECKOUT_CAPTURE";
  tenantId: string;
  orderId: string;
  providerCheckoutId: string;
  orderFingerprint: string;
  input: {
    tenantId: string;
    orderId: string;
    providerCheckoutId: string;
    providerPaymentId: string;
    providerEventId: string;
    orderFingerprint: string;
    capturedAmountCents: number;
    currency: string;
    occurredAt: Date;
    payloadHash: string;
    idempotencyKey: string;
  };
};

export type StripeCheckoutCancellationOperation = {
  kind: "CHECKOUT_CANCELLATION";
  tenantId: string;
  orderId: string;
  providerCheckoutId: string;
  orderFingerprint: string;
  input: {
    tenantId: string;
    orderId: string;
    providerCheckoutId: string;
    orderFingerprint: string;
    occurredAt: Date;
    reason: "SESSION_EXPIRED" | "ASYNC_PAYMENT_FAILED";
    idempotencyKey: string;
  };
};

export type PreparedStripeOperation =
  | StripeRenewalOperation
  | StripeSubscriptionEnrollmentOperation
  | StripeSubscriptionEnrollmentExpiredOperation
  | StripeSubscriptionInvoiceFailedOperation
  | StripeSubscriptionStateOperation
  | StripeRefundOperation
  | StripeRefundFailureOperation
  | StripeCheckoutCaptureOperation
  | StripeCheckoutCancellationOperation
  | { kind: "IGNORED"; reason: string };

function invalidShape(message: string) {
  return new StripeBoundaryError("INVALID_EVENT_SHAPE", message, { httpStatus: 422 });
}

function invalidMetadata(message: string, cause?: unknown) {
  return new StripeBoundaryError("INVALID_METADATA", message, { httpStatus: 422, cause });
}

function objectId(value: { id: string } | string | null | undefined, field: string) {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && typeof value.id === "string" && value.id) return value.id;
  throw invalidShape(`${field} is missing`);
}

function canonicalHash(value: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseSubscriptionMetadata(metadata: Stripe.Metadata | null) {
  const parsed = stripeSubscriptionMetadataSchema.safeParse(metadata ?? {});
  if (!parsed.success) {
    throw invalidMetadata(
      "Subscription invoice metadata is missing or does not match the supported contract",
      parsed.error,
    );
  }
  return parsed.data;
}

function parseRefundMetadata(metadata: Stripe.Metadata | null) {
  const parsed = stripeRefundMetadataSchema.safeParse(metadata ?? {});
  if (!parsed.success) {
    throw invalidMetadata(
      "Refund metadata is missing or does not match the supported contract",
      parsed.error,
    );
  }
  return parsed.data;
}

function parseCheckoutMetadata(metadata: Stripe.Metadata | null) {
  const parsed = stripeCheckoutMetadataSchema.safeParse(metadata ?? {});
  if (!parsed.success) {
    throw invalidMetadata(
      "Checkout Session metadata is missing or does not match the supported contract",
      parsed.error,
    );
  }
  return parsed.data;
}

function assertSingleAccountEvent(event: Stripe.Event) {
  if (event.account || event.context) {
    throw new StripeBoundaryError(
      "UNSUPPORTED_CONNECT_EVENT",
      "Connected-account Stripe events require a separately scoped adapter",
      { httpStatus: 422 },
    );
  }
}

async function invoiceAndPayment(
  event: Stripe.InvoicePaidEvent | Stripe.InvoicePaymentPaidEvent,
  reader: StripeInvoiceReader,
) {
  if (event.type === "invoice_payment.paid") {
    const invoiceReference = event.data.object.invoice;
    const invoice = typeof invoiceReference === "string"
      ? await reader.retrieveInvoice(invoiceReference)
      : "deleted" in invoiceReference && invoiceReference.deleted
        ? (() => { throw invalidShape("Paid invoice was deleted"); })()
        : invoiceReference;
    return { invoice, payment: event.data.object };
  }

  const invoice = event.data.object;
  const embedded = invoice.payments?.data.filter((payment) => payment.status === "paid") ?? [];
  const payments = embedded.length && !invoice.payments?.has_more
    ? embedded
    : await reader.listPaidInvoicePayments(invoice.id);
  if (payments.length !== 1) {
    throw invalidShape("Subscription settlement requires exactly one successful invoice payment");
  }
  return { invoice, payment: payments[0]! };
}

async function mapRenewalEvent(
  event: Stripe.InvoicePaidEvent | Stripe.InvoicePaymentPaidEvent,
  reader: StripeInvoiceReader,
): Promise<StripeRenewalOperation> {
  const { invoice, payment } = await invoiceAndPayment(event, reader);
  if (invoice.status !== "paid" || invoice.amount_remaining !== 0) {
    throw invalidShape("Invoice is not fully paid");
  }
  if (!["subscription_create", "subscription_cycle"].includes(invoice.billing_reason ?? "")) {
    throw invalidShape("Invoice is not an initial or recurring subscription cycle");
  }
  if (payment.status !== "paid" || payment.amount_paid == null || payment.amount_paid <= 0) {
    throw invalidShape("Invoice payment is not a positive successful capture");
  }
  if (payment.amount_paid !== invoice.amount_paid) {
    throw invalidShape("Invoice payment amount does not equal the paid invoice amount");
  }
  if (payment.payment.type !== "payment_intent" || !payment.payment.payment_intent) {
    throw invalidShape("Subscription settlement requires a Stripe PaymentIntent");
  }

  const parent = invoice.parent;
  if (parent?.type !== "subscription_details" || !parent.subscription_details) {
    throw invalidShape("Invoice is not attached to a Stripe subscription parent");
  }
  const metadata = parseSubscriptionMetadata(parent.subscription_details.metadata);
  const providerSubscriptionId = objectId(
    parent.subscription_details.subscription,
    "Stripe subscription id",
  );
  const providerPaymentId = objectId(
    payment.payment.payment_intent,
    "Stripe PaymentIntent id",
  );
  const providerCustomerId = objectId(invoice.customer, "Stripe invoice customer id");
  const invoiceLines = invoice.lines.has_more
    ? reader.listInvoiceLineItems
      ? await reader.listInvoiceLineItems(invoice.id)
      : (() => { throw invalidShape("Expanded invoice lines are incomplete"); })()
    : invoice.lines.data;
  const recurringLines = invoiceLines.filter((line) => (
    line.parent?.type === "subscription_item_details"
    && line.parent.subscription_item_details
    && !line.parent.subscription_item_details.proration
  ));
  if (recurringLines.length !== 1) {
    throw invalidShape("Subscription invoice requires exactly one non-prorated recurring line");
  }
  const recurringLine = recurringLines[0]!;
  if (
    recurringLine.pricing?.type !== "price_details"
    || !recurringLine.pricing.price_details
    || objectId(recurringLine.pricing.price_details.price, "Invoice line price id")
      !== metadata.giveaway_price_id
    || recurringLine.quantity !== 1
    || objectId(recurringLine.subscription, "Invoice line subscription id") !== providerSubscriptionId
    || recurringLine.amount !== payment.amount_paid
    || recurringLine.currency.toUpperCase() !== invoice.currency.toUpperCase()
  ) {
    throw invalidShape("Subscription invoice line does not match its immutable price metadata");
  }
  const periodStartsAt = new Date(recurringLine.period.start * 1000);
  const periodEndsAt = new Date(recurringLine.period.end * 1000);
  if (
    Number.isNaN(periodStartsAt.getTime())
    || Number.isNaN(periodEndsAt.getTime())
    || periodEndsAt <= periodStartsAt
  ) {
    throw invalidShape("Subscription invoice line period is invalid");
  }
  const paidAtSeconds = payment.status_transitions.paid_at
    ?? invoice.status_transitions.paid_at
    ?? invoice.created;
  const occurredAt = new Date(paidAtSeconds * 1000);
  if (Number.isNaN(occurredAt.getTime())) throw invalidShape("Invoice paid timestamp is invalid");
  const currency = invoice.currency.toUpperCase();
  const providerEventId = `invoice:${invoice.id}`;
  const payloadHash = canonicalHash({
    contract: STRIPE_SUBSCRIPTION_METADATA_CONTRACT,
    tenantId: metadata.giveaway_tenant_id,
    subscriptionId: metadata.giveaway_subscription_id,
    subscriptionFingerprint: metadata.giveaway_subscription_fingerprint,
    providerSubscriptionId,
    providerCustomerId,
    invoiceId: invoice.id,
    providerPaymentId,
    providerPriceId: metadata.giveaway_price_id,
    billingReason: invoice.billing_reason,
    capturedAmountCents: payment.amount_paid,
    currency,
    periodStartsAt: periodStartsAt.toISOString(),
    periodEndsAt: periodEndsAt.toISOString(),
    occurredAt: occurredAt.toISOString(),
  });

  return {
    kind: "SUBSCRIPTION_RENEWAL",
    tenantId: metadata.giveaway_tenant_id,
    subscriptionId: metadata.giveaway_subscription_id,
    providerSubscriptionId,
    invoiceId: invoice.id,
    input: {
      tenantId: metadata.giveaway_tenant_id,
      subscriptionId: metadata.giveaway_subscription_id,
      subscriptionFingerprint: metadata.giveaway_subscription_fingerprint,
      providerSubscriptionId,
      providerCustomerId,
      providerPriceId: metadata.giveaway_price_id,
      providerInvoiceId: invoice.id,
      providerEventId,
      providerPaymentId,
      billingReason: invoice.billing_reason as "subscription_create" | "subscription_cycle",
      capturedAmountCents: payment.amount_paid,
      currency,
      periodStartsAt,
      periodEndsAt,
      occurredAt,
      payloadHash,
      idempotencyKey: `stripe-invoice:${invoice.id}`,
    },
  };
}

function mapRefundEvent(
  event: Stripe.RefundCreatedEvent | Stripe.RefundUpdatedEvent | Stripe.RefundFailedEvent,
): StripeRefundOperation | StripeRefundFailureOperation | { kind: "IGNORED"; reason: string } {
  const refund = event.data.object;
  if (!["succeeded", "failed", "canceled"].includes(refund.status ?? "")) {
    return { kind: "IGNORED", reason: `refund_status_${refund.status ?? "unknown"}` };
  }
  if (!Number.isSafeInteger(refund.amount) || refund.amount <= 0) {
    throw invalidShape("Stripe refund amount is invalid");
  }
  const metadata = parseRefundMetadata(refund.metadata);
  const providerPaymentId = objectId(refund.payment_intent, "Refund PaymentIntent id");
  const occurredAt = new Date(event.created * 1000);
  if (Number.isNaN(occurredAt.getTime())) throw invalidShape("Refund event timestamp is invalid");
  const reason = refund.reason
    ? `Stripe refund settled: ${refund.reason}`
    : "Stripe refund settled: unspecified provider reason";

  if (refund.status === "failed" || refund.status === "canceled") {
    return {
      kind: "REFUND_FAILURE",
      tenantId: metadata.giveaway_tenant_id,
      orderId: metadata.giveaway_order_id,
      refundId: metadata.giveaway_refund_id,
      allocationFingerprint: metadata.giveaway_allocation_fingerprint,
      providerPaymentId,
      providerRefundId: refund.id,
      input: {
        tenantId: metadata.giveaway_tenant_id,
        orderId: metadata.giveaway_order_id,
        refundId: metadata.giveaway_refund_id,
        allocationFingerprint: metadata.giveaway_allocation_fingerprint,
        providerPaymentId,
        providerRefundId: refund.id,
        providerEventId: event.id,
        amountCents: refund.amount,
        currency: refund.currency.toUpperCase(),
        providerStatus: refund.status,
        failureReason: refund.failure_reason
          ? `Stripe refund ${refund.status}: ${refund.failure_reason}`
          : `Stripe refund ${refund.status} without a provider failure reason`,
        occurredAt,
      },
    };
  }

  return {
    kind: "REFUND_SETTLEMENT",
    tenantId: metadata.giveaway_tenant_id,
    orderId: metadata.giveaway_order_id,
    refundId: metadata.giveaway_refund_id,
    allocationFingerprint: metadata.giveaway_allocation_fingerprint,
    providerPaymentId,
    providerRefundId: refund.id,
    input: {
      tenantId: metadata.giveaway_tenant_id,
      orderId: metadata.giveaway_order_id,
      refundId: metadata.giveaway_refund_id,
      allocationFingerprint: metadata.giveaway_allocation_fingerprint,
      provider: "STRIPE",
      providerPaymentId,
      providerRefundId: refund.id,
      amountCents: refund.amount,
      currency: refund.currency.toUpperCase(),
      reason,
      actorType: "PAYMENT_PROVIDER",
      actorId: "STRIPE",
      occurredAt,
      idempotencyKey: `stripe-refund:${refund.id}`,
    },
  };
}

function subscriptionCheckoutMetadata(session: Stripe.Checkout.Session) {
  if (session.mode !== "subscription") throw invalidShape("Checkout Session is not a subscription enrollment");
  const metadata = parseSubscriptionMetadata(session.metadata);
  if (session.client_reference_id !== metadata.giveaway_subscription_id) {
    throw invalidMetadata("Subscription Checkout Session reference does not match its metadata");
  }
  return metadata;
}

function mapSubscriptionEnrollmentEvent(
  event: Stripe.CheckoutSessionCompletedEvent,
): StripeSubscriptionEnrollmentOperation {
  const session = event.data.object;
  const metadata = subscriptionCheckoutMetadata(session);
  if (session.status !== "complete" || session.payment_status !== "paid") {
    throw invalidShape("Subscription Checkout Session is not fully paid and complete");
  }
  const providerSubscriptionId = objectId(session.subscription, "Checkout Session subscription id");
  const providerCustomerId = objectId(session.customer, "Checkout Session customer id");
  const occurredAt = new Date(event.created * 1000);
  if (Number.isNaN(occurredAt.getTime())) throw invalidShape("Subscription checkout timestamp is invalid");
  return {
    kind: "SUBSCRIPTION_ENROLLMENT",
    tenantId: metadata.giveaway_tenant_id,
    subscriptionId: metadata.giveaway_subscription_id,
    providerSubscriptionId,
    input: {
      tenantId: metadata.giveaway_tenant_id,
      subscriptionId: metadata.giveaway_subscription_id,
      subscriptionFingerprint: metadata.giveaway_subscription_fingerprint,
      providerCheckoutId: session.id,
      providerPriceId: metadata.giveaway_price_id,
      providerSubscriptionId,
      providerCustomerId,
      providerEventId: event.id,
      occurredAt,
    },
  };
}

function mapSubscriptionEnrollmentExpiredEvent(
  event: Stripe.CheckoutSessionExpiredEvent,
): StripeSubscriptionEnrollmentExpiredOperation {
  const session = event.data.object;
  const metadata = subscriptionCheckoutMetadata(session);
  if (session.status !== "expired" || session.payment_status === "paid") {
    throw invalidShape("Subscription Checkout Session is not an unpaid expired enrollment");
  }
  const occurredAt = new Date(event.created * 1000);
  if (Number.isNaN(occurredAt.getTime())) throw invalidShape("Subscription expiration timestamp is invalid");
  return {
    kind: "SUBSCRIPTION_ENROLLMENT_EXPIRED",
    tenantId: metadata.giveaway_tenant_id,
    subscriptionId: metadata.giveaway_subscription_id,
    providerSubscriptionId: "",
    input: {
      tenantId: metadata.giveaway_tenant_id,
      subscriptionId: metadata.giveaway_subscription_id,
      subscriptionFingerprint: metadata.giveaway_subscription_fingerprint,
      providerCheckoutId: session.id,
      providerPriceId: metadata.giveaway_price_id,
      providerEventId: event.id,
      occurredAt,
    },
  };
}

async function recurringInvoiceLine(
  invoice: Stripe.Invoice,
  reader: StripeInvoiceReader,
  expectedPriceId: string,
  expectedSubscriptionId: string,
) {
  const lines = invoice.lines.has_more
    ? reader.listInvoiceLineItems
      ? await reader.listInvoiceLineItems(invoice.id)
      : (() => { throw invalidShape("Expanded invoice lines are incomplete"); })()
    : invoice.lines.data;
  const recurring = lines.filter((line) => (
    line.parent?.type === "subscription_item_details"
    && line.parent.subscription_item_details
    && !line.parent.subscription_item_details.proration
  ));
  if (recurring.length !== 1) {
    throw invalidShape("Subscription invoice requires exactly one non-prorated recurring line");
  }
  const line = recurring[0]!;
  if (
    line.pricing?.type !== "price_details"
    || !line.pricing.price_details
    || objectId(line.pricing.price_details.price, "Invoice line price id") !== expectedPriceId
    || line.quantity !== 1
    || objectId(line.subscription, "Invoice line subscription id") !== expectedSubscriptionId
  ) {
    throw invalidShape("Subscription invoice line does not match its immutable price metadata");
  }
  return line;
}

async function mapSubscriptionInvoiceFailedEvent(
  event: Stripe.InvoicePaymentFailedEvent,
  reader: StripeInvoiceReader,
): Promise<StripeSubscriptionInvoiceFailedOperation> {
  const invoice = event.data.object;
  if (!["subscription_create", "subscription_cycle"].includes(invoice.billing_reason ?? "")) {
    throw invalidShape("Failed invoice is not an initial or recurring subscription cycle");
  }
  const parent = invoice.parent;
  if (parent?.type !== "subscription_details" || !parent.subscription_details) {
    throw invalidShape("Failed invoice is not attached to a Stripe subscription");
  }
  const metadata = parseSubscriptionMetadata(parent.subscription_details.metadata);
  const providerSubscriptionId = objectId(
    parent.subscription_details.subscription,
    "Stripe subscription id",
  );
  const providerCustomerId = objectId(invoice.customer, "Stripe invoice customer id");
  const line = await recurringInvoiceLine(
    invoice,
    reader,
    metadata.giveaway_price_id,
    providerSubscriptionId,
  );
  if (line.currency.toUpperCase() !== invoice.currency.toUpperCase()) {
    throw invalidShape("Failed subscription invoice line currency is inconsistent");
  }
  const occurredAt = new Date(event.created * 1000);
  if (Number.isNaN(occurredAt.getTime())) throw invalidShape("Failed invoice timestamp is invalid");
  return {
    kind: "SUBSCRIPTION_INVOICE_FAILED",
    tenantId: metadata.giveaway_tenant_id,
    subscriptionId: metadata.giveaway_subscription_id,
    providerSubscriptionId,
    input: {
      tenantId: metadata.giveaway_tenant_id,
      subscriptionId: metadata.giveaway_subscription_id,
      subscriptionFingerprint: metadata.giveaway_subscription_fingerprint,
      providerSubscriptionId,
      providerCustomerId,
      providerPriceId: metadata.giveaway_price_id,
      providerInvoiceId: invoice.id,
      providerEventId: event.id,
      occurredAt,
    },
  };
}

function mapSubscriptionStateEvent(
  event: Stripe.CustomerSubscriptionUpdatedEvent | Stripe.CustomerSubscriptionDeletedEvent,
): StripeSubscriptionStateOperation {
  const subscription = event.data.object;
  const metadata = parseSubscriptionMetadata(subscription.metadata);
  if (subscription.id === "" || subscription.id == null) throw invalidShape("Stripe subscription id is missing");
  if (subscription.items.has_more || subscription.items.data.length !== 1) {
    throw invalidShape("Stripe membership subscription must contain exactly one item");
  }
  const item = subscription.items.data[0]!;
  const price = item.price;
  if (
    price.id !== metadata.giveaway_price_id
    || price.type !== "recurring"
    || !price.recurring
    || price.unit_amount == null
    || price.unit_amount <= 0
    || item.quantity !== 1
  ) {
    throw invalidShape("Stripe subscription item does not match the membership metadata");
  }
  const periodStartsAt = new Date(item.current_period_start * 1000);
  const periodEndsAt = new Date(item.current_period_end * 1000);
  const occurredAt = new Date(event.created * 1000);
  const endedAt = subscription.ended_at == null ? null : new Date(subscription.ended_at * 1000);
  if (
    Number.isNaN(periodStartsAt.getTime())
    || Number.isNaN(periodEndsAt.getTime())
    || periodEndsAt <= periodStartsAt
    || Number.isNaN(occurredAt.getTime())
    || (endedAt && Number.isNaN(endedAt.getTime()))
  ) {
    throw invalidShape("Stripe subscription state timestamps are invalid");
  }
  if (event.type === "customer.subscription.deleted" && subscription.status !== "canceled") {
    throw invalidShape("Deleted subscription event is not canceled");
  }
  const billingInterval = price.recurring.interval.toUpperCase() as "DAY" | "WEEK" | "MONTH" | "YEAR";
  return {
    kind: "SUBSCRIPTION_STATE",
    tenantId: metadata.giveaway_tenant_id,
    subscriptionId: metadata.giveaway_subscription_id,
    providerSubscriptionId: subscription.id,
    input: {
      tenantId: metadata.giveaway_tenant_id,
      subscriptionId: metadata.giveaway_subscription_id,
      subscriptionFingerprint: metadata.giveaway_subscription_fingerprint,
      providerSubscriptionId: subscription.id,
      providerCustomerId: objectId(subscription.customer, "Stripe subscription customer id"),
      providerPriceId: price.id,
      priceCents: price.unit_amount,
      currency: price.currency.toUpperCase(),
      billingInterval,
      billingIntervalCount: price.recurring.interval_count,
      providerEventId: event.id,
      providerStatus: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      periodStartsAt,
      periodEndsAt,
      endedAt,
      occurredAt,
    },
  };
}

function checkoutIdentity(session: Stripe.Checkout.Session) {
  if (session.mode !== "payment") throw invalidShape("Checkout Session is not a one-time payment");
  if (session.status !== "complete" && session.status !== "expired") {
    throw invalidShape("Checkout Session is not complete or expired");
  }
  const metadata = parseCheckoutMetadata(session.metadata);
  if (session.client_reference_id !== metadata.giveaway_order_id) {
    throw invalidMetadata("Checkout Session client reference does not match order metadata");
  }
  return { metadata };
}

function mapCheckoutCaptureEvent(
  event: Stripe.CheckoutSessionCompletedEvent | Stripe.CheckoutSessionAsyncPaymentSucceededEvent,
): StripeCheckoutCaptureOperation | { kind: "IGNORED"; reason: string } {
  const session = event.data.object;
  const { metadata } = checkoutIdentity(session);
  if (session.status !== "complete") throw invalidShape("Paid Checkout Session is not complete");
  if (session.payment_status !== "paid") {
    if (event.type === "checkout.session.completed") {
      return { kind: "IGNORED", reason: `checkout_payment_status_${session.payment_status}` };
    }
    throw invalidShape("Successful asynchronous Checkout Session is not paid");
  }
  if (!Number.isSafeInteger(session.amount_total) || (session.amount_total ?? 0) <= 0) {
    throw invalidShape("Checkout Session total is invalid");
  }
  if (!session.currency) throw invalidShape("Checkout Session currency is missing");
  const providerPaymentId = objectId(session.payment_intent, "Checkout Session PaymentIntent id");
  const occurredAt = new Date(event.created * 1000);
  if (Number.isNaN(occurredAt.getTime())) throw invalidShape("Checkout capture timestamp is invalid");
  const currency = session.currency.toUpperCase();
  const providerEventId = `checkout:${session.id}`;
  const payloadHash = canonicalHash({
    contract: STRIPE_CHECKOUT_METADATA_CONTRACT,
    tenantId: metadata.giveaway_tenant_id,
    orderId: metadata.giveaway_order_id,
    providerCheckoutId: session.id,
    providerPaymentId,
    orderFingerprint: metadata.giveaway_order_fingerprint,
    capturedAmountCents: session.amount_total!,
    currency,
    occurredAt: occurredAt.toISOString(),
  });
  return {
    kind: "CHECKOUT_CAPTURE",
    tenantId: metadata.giveaway_tenant_id,
    orderId: metadata.giveaway_order_id,
    providerCheckoutId: session.id,
    orderFingerprint: metadata.giveaway_order_fingerprint,
    input: {
      tenantId: metadata.giveaway_tenant_id,
      orderId: metadata.giveaway_order_id,
      providerCheckoutId: session.id,
      providerPaymentId,
      providerEventId,
      orderFingerprint: metadata.giveaway_order_fingerprint,
      capturedAmountCents: session.amount_total!,
      currency,
      occurredAt,
      payloadHash,
      idempotencyKey: `stripe-checkout-capture:${session.id}`,
    },
  };
}

function mapCheckoutCancellationEvent(
  event: Stripe.CheckoutSessionExpiredEvent | Stripe.CheckoutSessionAsyncPaymentFailedEvent,
): StripeCheckoutCancellationOperation {
  const session = event.data.object;
  const { metadata } = checkoutIdentity(session);
  if (event.type === "checkout.session.expired" && session.status !== "expired") {
    throw invalidShape("Expired Checkout Session event does not contain an expired session");
  }
  if (event.type === "checkout.session.async_payment_failed" && session.status !== "complete") {
    throw invalidShape("Failed asynchronous Checkout Session is not complete");
  }
  if (session.payment_status === "paid") {
    throw invalidShape("Paid Checkout Session cannot be mapped to cancellation");
  }
  const occurredAt = new Date(event.created * 1000);
  if (Number.isNaN(occurredAt.getTime())) throw invalidShape("Checkout cancellation timestamp is invalid");
  const reason = event.type === "checkout.session.expired"
    ? "SESSION_EXPIRED" as const
    : "ASYNC_PAYMENT_FAILED" as const;
  return {
    kind: "CHECKOUT_CANCELLATION",
    tenantId: metadata.giveaway_tenant_id,
    orderId: metadata.giveaway_order_id,
    providerCheckoutId: session.id,
    orderFingerprint: metadata.giveaway_order_fingerprint,
    input: {
      tenantId: metadata.giveaway_tenant_id,
      orderId: metadata.giveaway_order_id,
      providerCheckoutId: session.id,
      orderFingerprint: metadata.giveaway_order_fingerprint,
      occurredAt,
      reason,
      idempotencyKey: `stripe-checkout-cancel:${session.id}:${reason}`,
    },
  };
}

export async function prepareStripeOperation(
  event: Stripe.Event,
  reader: StripeInvoiceReader,
): Promise<PreparedStripeOperation> {
  assertSingleAccountEvent(event);
  switch (event.type) {
    case "checkout.session.completed":
      return event.data.object.mode === "subscription"
        ? mapSubscriptionEnrollmentEvent(event)
        : mapCheckoutCaptureEvent(event);
    case "checkout.session.async_payment_succeeded":
      return mapCheckoutCaptureEvent(event);
    case "checkout.session.expired":
      return event.data.object.mode === "subscription"
        ? mapSubscriptionEnrollmentExpiredEvent(event)
        : mapCheckoutCancellationEvent(event);
    case "checkout.session.async_payment_failed":
      return mapCheckoutCancellationEvent(event);
    case "invoice.paid":
    case "invoice_payment.paid":
      return mapRenewalEvent(event, reader);
    case "invoice.payment_failed":
      return mapSubscriptionInvoiceFailedEvent(event, reader);
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return mapSubscriptionStateEvent(event);
    case "refund.created":
    case "refund.failed":
    case "refund.updated":
      return mapRefundEvent(event);
    default:
      return { kind: "IGNORED", reason: `unsupported_event_${event.type}` };
  }
}
