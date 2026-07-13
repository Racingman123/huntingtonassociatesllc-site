import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { z } from "zod";

export const STRIPE_CHECKOUT_METADATA_CONTRACT = "one-time-checkout-v1";

const databaseId = z.string().trim().min(1).max(191);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

export const stripeCheckoutMetadataSchema = z.object({
  giveaway_contract: z.literal(STRIPE_CHECKOUT_METADATA_CONTRACT),
  giveaway_tenant_id: databaseId,
  giveaway_order_id: databaseId,
  giveaway_order_fingerprint: sha256Hex,
});

export type StripeCheckoutMetadata = z.infer<typeof stripeCheckoutMetadataSchema>;

export type CheckoutFingerprintFacts = {
  tenantId: string;
  campaignId: string;
  orderId: string;
  orderNumber: string;
  currency: string;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  customerFingerprint: string;
  receiptTokenHash: string;
  checkoutExpiresAt: string;
  lines: Array<{
    id: string;
    productId: string;
    variantId: string | null;
    productTitle: string;
    variantTitle: string | null;
    sku: string | null;
    quantity: number;
    unitPriceCents: number;
    discountCents: number;
    qualifyingCents: number;
    quotedEntries: string;
    calculationJson: string;
  }>;
};

export function createCheckoutFingerprint(facts: CheckoutFingerprintFacts) {
  const canonical = {
    contract: STRIPE_CHECKOUT_METADATA_CONTRACT,
    ...facts,
    currency: facts.currency.toUpperCase(),
    lines: [...facts.lines].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export type PreparedStripeCheckoutRequest = {
  tenantId: string;
  orderId: string;
  orderNumber: string;
  orderFingerprint: string;
  customerEmail: string;
  expectedAmountCents: number;
  currency: string;
  shippingCents: number;
  taxCents: number;
  expiresAt: Date;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
  lines: Array<{
    productTitle: string;
    variantTitle: string | null;
    quantity: number;
    unitPriceCents: number;
    discountCents: number;
  }>;
};

function metadata(input: PreparedStripeCheckoutRequest): StripeCheckoutMetadata {
  return stripeCheckoutMetadataSchema.parse({
    giveaway_contract: STRIPE_CHECKOUT_METADATA_CONTRACT,
    giveaway_tenant_id: input.tenantId,
    giveaway_order_id: input.orderId,
    giveaway_order_fingerprint: input.orderFingerprint,
  });
}

function fixedLine(name: string, amountCents: number, currency: string): Stripe.Checkout.SessionCreateParams.LineItem {
  return {
    quantity: 1,
    price_data: {
      currency,
      unit_amount: amountCents,
      product_data: { name },
    },
  };
}

/** Builds Stripe parameters exclusively from a persisted prepared-order DTO. */
export function buildStripeCheckoutSessionParams(
  input: PreparedStripeCheckoutRequest,
): Stripe.Checkout.SessionCreateParams {
  if (!Number.isSafeInteger(input.expectedAmountCents) || input.expectedAmountCents <= 0) {
    throw new Error("Prepared Stripe order total is invalid");
  }
  const currency = input.currency.toLowerCase();
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = input.lines.map((line) => {
    if (line.discountCents !== 0) {
      throw new Error("Prepared Stripe checkout requires persisted discounts to be represented explicitly");
    }
    if (!Number.isSafeInteger(line.unitPriceCents) || line.unitPriceCents <= 0) {
      throw new Error("Prepared Stripe order line price is invalid");
    }
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new Error("Prepared Stripe order line quantity is invalid");
    }
    return {
      quantity: line.quantity,
      price_data: {
        currency,
        unit_amount: line.unitPriceCents,
        product_data: {
          name: line.variantTitle
            ? `${line.productTitle} — ${line.variantTitle}`
            : line.productTitle,
        },
      },
    };
  });
  if (input.shippingCents > 0) lineItems.push(fixedLine("Shipping", input.shippingCents, currency));
  if (input.taxCents > 0) lineItems.push(fixedLine("Tax", input.taxCents, currency));

  const representedTotal = input.lines.reduce(
    (sum, line) => sum + line.unitPriceCents * line.quantity - line.discountCents,
    input.shippingCents + input.taxCents,
  );
  if (!Number.isSafeInteger(representedTotal) || representedTotal !== input.expectedAmountCents) {
    throw new Error("Prepared Stripe line items do not equal the persisted order total");
  }

  const checkoutMetadata = metadata(input);
  return {
    mode: "payment",
    payment_method_types: ["card"],
    client_reference_id: input.orderId,
    customer_email: input.customerEmail,
    line_items: lineItems,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    expires_at: Math.floor(input.expiresAt.getTime() / 1000),
    metadata: checkoutMetadata,
    payment_intent_data: { metadata: checkoutMetadata },
  };
}
