import { describe, expect, it } from "vitest";
import {
  buildStripeSubscriptionCheckoutParams,
  createStripeSubscriptionFingerprint,
  STRIPE_SUBSCRIPTION_METADATA_CONTRACT,
  type PreparedStripeSubscriptionRequest,
} from "./subscription-contract";

function request(): PreparedStripeSubscriptionRequest {
  const facts = {
    tenantId: "tenant_123",
    subscriptionId: "subscription_123",
    planId: "plan_123",
    userId: "user_123",
    entrantId: "entrant_123",
    providerPriceId: "price_membership_123",
    priceCents: 2500,
    currency: "USD",
    billingInterval: "MONTH",
    billingIntervalCount: 1,
    enrollmentIdempotencyKey: "enroll:request-123",
    checkoutExpiresAt: "2026-07-12T13:00:00.000Z",
  };
  return {
    ...facts,
    subscriptionFingerprint: createStripeSubscriptionFingerprint(facts),
    customerEmail: "member@example.test",
    successUrl: "https://giveaway.example/account/membership?checkout=processing",
    cancelUrl: "https://giveaway.example/membership?checkout=cancelled",
    providerIdempotencyKey: "stripe-membership:test",
  };
}

describe("Stripe subscription enrollment contract", () => {
  it("builds subscription Checkout from the immutable local price snapshot", () => {
    const input = request();
    const params = buildStripeSubscriptionCheckoutParams(input);
    expect(params).toMatchObject({
      mode: "subscription",
      payment_method_types: ["card"],
      client_reference_id: input.subscriptionId,
      customer_email: input.customerEmail,
      line_items: [{ price: input.providerPriceId, quantity: 1 }],
      metadata: {
        giveaway_contract: STRIPE_SUBSCRIPTION_METADATA_CONTRACT,
        giveaway_tenant_id: input.tenantId,
        giveaway_subscription_id: input.subscriptionId,
        giveaway_subscription_fingerprint: input.subscriptionFingerprint,
        giveaway_price_id: input.providerPriceId,
      },
      subscription_data: {
        metadata: {
          giveaway_subscription_id: input.subscriptionId,
          giveaway_subscription_fingerprint: input.subscriptionFingerprint,
        },
      },
    });
  });

  it("fingerprints price, owner, interval, and idempotency changes", () => {
    const original = request();
    const changed = createStripeSubscriptionFingerprint({
      ...original,
      priceCents: original.priceCents + 1,
    });
    expect(changed).not.toBe(original.subscriptionFingerprint);
  });
});
