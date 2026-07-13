import { describe, expect, it } from "vitest";
import {
  buildStripeCheckoutSessionParams,
  createCheckoutFingerprint,
  STRIPE_CHECKOUT_METADATA_CONTRACT,
  type CheckoutFingerprintFacts,
  type PreparedStripeCheckoutRequest,
} from "./checkout-contract";

function fingerprintFacts(): CheckoutFingerprintFacts {
  return {
    tenantId: "tenant_123",
    campaignId: "campaign_123",
    orderId: "order_123",
    orderNumber: "NS-123",
    currency: "USD",
    subtotalCents: 4900,
    discountCents: 0,
    shippingCents: 1200,
    taxCents: 0,
    totalCents: 6100,
    customerFingerprint: "b".repeat(64),
    receiptTokenHash: "c".repeat(64),
    checkoutExpiresAt: "2026-07-12T12:35:00.000Z",
    lines: [
      {
        id: "line_b",
        productId: "product_b",
        variantId: "variant_b",
        productTitle: "Prepared product",
        variantTitle: "Default",
        sku: "SKU-B",
        quantity: 1,
        unitPriceCents: 4900,
        discountCents: 0,
        qualifyingCents: 4900,
        quotedEntries: "12250",
        calculationJson: "{\"schemaVersion\":1}",
      },
    ],
  };
}

function request(): PreparedStripeCheckoutRequest {
  return {
    tenantId: "tenant_123",
    orderId: "order_123",
    orderNumber: "NS-123",
    orderFingerprint: "a".repeat(64),
    customerEmail: "buyer@example.com",
    expectedAmountCents: 6100,
    currency: "USD",
    shippingCents: 1200,
    taxCents: 0,
    expiresAt: new Date("2026-07-12T12:35:00.000Z"),
    successUrl: "https://shop.example/checkout/success?receipt=bearer",
    cancelUrl: "https://shop.example/checkout?cancelled=1",
    idempotencyKey: "stripe-checkout:immutable",
    lines: [{
      productTitle: "Prepared product",
      variantTitle: "Default",
      quantity: 1,
      unitPriceCents: 4900,
      discountCents: 0,
    }],
  };
}

describe("prepared Stripe checkout contract", () => {
  it("fingerprints canonical persisted facts independent of input line order", () => {
    const facts = fingerprintFacts();
    const second = {
      ...facts.lines[0]!,
      id: "line_a",
      productId: "product_a",
      variantId: "variant_a",
    };
    expect(createCheckoutFingerprint({ ...facts, lines: [facts.lines[0]!, second] }))
      .toBe(createCheckoutFingerprint({ ...facts, lines: [second, facts.lines[0]!] }));
    expect(createCheckoutFingerprint(facts)).not.toBe(
      createCheckoutFingerprint({ ...facts, totalCents: 6101 }),
    );
  });

  it("builds exact hosted line items and copies the identity contract to Session and PaymentIntent", () => {
    const params = buildStripeCheckoutSessionParams(request());
    expect(params).toMatchObject({
      mode: "payment",
      client_reference_id: "order_123",
      customer_email: "buyer@example.com",
      payment_method_types: ["card"],
      success_url: expect.stringContaining("receipt=bearer"),
      metadata: {
        giveaway_contract: STRIPE_CHECKOUT_METADATA_CONTRACT,
        giveaway_tenant_id: "tenant_123",
        giveaway_order_id: "order_123",
        giveaway_order_fingerprint: "a".repeat(64),
      },
      payment_intent_data: {
        metadata: {
          giveaway_contract: STRIPE_CHECKOUT_METADATA_CONTRACT,
          giveaway_order_id: "order_123",
        },
      },
    });
    expect(params.line_items).toHaveLength(2);
    expect(params.line_items?.[0]).toMatchObject({ quantity: 1, price_data: { unit_amount: 4900 } });
    expect(params.line_items?.[1]).toMatchObject({ quantity: 1, price_data: { unit_amount: 1200 } });
  });

  it("rejects totals or discounts that are not exactly represented at Stripe", () => {
    expect(() => buildStripeCheckoutSessionParams({ ...request(), expectedAmountCents: 6000 }))
      .toThrow(/do not equal/);
    expect(() => buildStripeCheckoutSessionParams({
      ...request(),
      lines: [{ ...request().lines[0]!, discountCents: 100 }],
      expectedAmountCents: 6000,
    })).toThrow(/discounts/);
  });
});
