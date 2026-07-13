import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { z } from "zod";

export const STRIPE_SUBSCRIPTION_METADATA_CONTRACT = "subscription-billing-v1";

const databaseId = z.string().trim().min(1).max(191);
const providerId = z.string().trim().min(1).max(255);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

export const stripeSubscriptionMetadataSchema = z.object({
  giveaway_contract: z.literal(STRIPE_SUBSCRIPTION_METADATA_CONTRACT),
  giveaway_tenant_id: databaseId,
  giveaway_subscription_id: databaseId,
  giveaway_subscription_fingerprint: sha256Hex,
  giveaway_price_id: providerId,
});

export type StripeSubscriptionMetadata = z.infer<typeof stripeSubscriptionMetadataSchema>;

export type StripeSubscriptionFingerprintFacts = {
  tenantId: string;
  subscriptionId: string;
  planId: string;
  userId: string;
  entrantId: string;
  providerPriceId: string;
  priceCents: number;
  currency: string;
  billingInterval: string;
  billingIntervalCount: number;
  enrollmentIdempotencyKey: string;
  checkoutExpiresAt: string;
};

export function createStripeSubscriptionFingerprint(facts: StripeSubscriptionFingerprintFacts) {
  return createHash("sha256").update(JSON.stringify({
    contract: STRIPE_SUBSCRIPTION_METADATA_CONTRACT,
    ...facts,
    currency: facts.currency.toUpperCase(),
    billingInterval: facts.billingInterval.toUpperCase(),
  })).digest("hex");
}

export type PreparedStripeSubscriptionRequest = StripeSubscriptionFingerprintFacts & {
  subscriptionFingerprint: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  providerIdempotencyKey: string;
};

export function stripeSubscriptionMetadata(
  input: PreparedStripeSubscriptionRequest,
): StripeSubscriptionMetadata {
  return stripeSubscriptionMetadataSchema.parse({
    giveaway_contract: STRIPE_SUBSCRIPTION_METADATA_CONTRACT,
    giveaway_tenant_id: input.tenantId,
    giveaway_subscription_id: input.subscriptionId,
    giveaway_subscription_fingerprint: input.subscriptionFingerprint,
    giveaway_price_id: input.providerPriceId,
  });
}

/** Builds hosted enrollment exclusively from the persisted subscription snapshot. */
export function buildStripeSubscriptionCheckoutParams(
  input: PreparedStripeSubscriptionRequest,
): Stripe.Checkout.SessionCreateParams {
  if (!Number.isSafeInteger(input.priceCents) || input.priceCents <= 0) {
    throw new Error("Prepared subscription price is invalid");
  }
  if (!Number.isSafeInteger(input.billingIntervalCount) || input.billingIntervalCount <= 0) {
    throw new Error("Prepared subscription interval is invalid");
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new Error("Prepared subscription currency is invalid");
  }
  const expiresAt = Math.floor(new Date(input.checkoutExpiresAt).getTime() / 1000);
  if (!Number.isSafeInteger(expiresAt)) throw new Error("Prepared subscription expiration is invalid");
  const metadata = stripeSubscriptionMetadata(input);
  return {
    mode: "subscription",
    payment_method_types: ["card"],
    client_reference_id: input.subscriptionId,
    customer_email: input.customerEmail,
    line_items: [{ price: input.providerPriceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    expires_at: expiresAt,
    metadata,
    subscription_data: { metadata },
  };
}
