import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { assertStripeEventEnvelope, verifyStripeWebhookSignature } from "./signature";

const secret = "whsec_test_boundary_secret";
const payload = JSON.stringify({
  id: "evt_signature_test",
  object: "event",
  api_version: Stripe.API_VERSION,
  created: 1_783_857_600,
  data: { object: { id: "re_123", object: "refund" } },
  livemode: false,
  pending_webhooks: 1,
  request: null,
  type: "refund.created",
});

describe("Stripe signature boundary", () => {
  it("verifies the untouched raw request body", async () => {
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
      timestamp: Math.floor(Date.now() / 1000),
    });
    const event = await verifyStripeWebhookSignature(
      new TextEncoder().encode(payload),
      signature,
      secret,
    );
    expect(event.id).toBe("evt_signature_test");
  });

  it("rejects a body changed after Stripe signed it", async () => {
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
      timestamp: Math.floor(Date.now() / 1000),
    });
    await expect(verifyStripeWebhookSignature(
      new TextEncoder().encode(`${payload} `),
      signature,
      secret,
    )).rejects.toMatchObject({ code: "INVALID_SIGNATURE", httpStatus: 400 });
  });

  it("fails closed on API-version and livemode mismatches", () => {
    const event = JSON.parse(payload) as Stripe.Event;
    expect(() => assertStripeEventEnvelope(event, {
      apiVersion: "2025-01-01.acacia",
      livemode: false,
    })).toThrowError(expect.objectContaining({ code: "INVALID_API_VERSION" }));
    expect(() => assertStripeEventEnvelope(event, {
      apiVersion: Stripe.API_VERSION,
      livemode: true,
    })).toThrowError(expect.objectContaining({ code: "INVALID_EVENT_MODE" }));
  });
});

