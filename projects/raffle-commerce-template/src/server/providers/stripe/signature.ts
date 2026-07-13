import Stripe from "stripe";
import { StripeBoundaryError } from "./errors";

export const STRIPE_WEBHOOK_MAX_BYTES = 1024 * 1024;

export async function verifyStripeWebhookSignature(
  rawBody: Uint8Array,
  signature: string,
  secret: string,
  webhooks: {
    constructEventAsync(
      payload: string | Uint8Array,
      header: string | string[] | Uint8Array,
      signingSecret: string,
    ): Promise<Stripe.Event>;
  } = Stripe.webhooks,
) {
  if (!signature) {
    throw new StripeBoundaryError("INVALID_SIGNATURE", "Stripe signature header is missing", {
      httpStatus: 400,
    });
  }
  if (!secret) {
    throw new StripeBoundaryError("CONFIGURATION_ERROR", "Stripe webhook secret is not configured", {
      httpStatus: 503,
      retryable: true,
    });
  }
  try {
    return await webhooks.constructEventAsync(rawBody, signature, secret);
  } catch (error) {
    throw new StripeBoundaryError("INVALID_SIGNATURE", "Stripe signature verification failed", {
      httpStatus: 400,
      cause: error,
    });
  }
}

export function assertStripeEventEnvelope(
  event: Stripe.Event,
  expected: { apiVersion: string; livemode: boolean },
) {
  if (event.api_version !== expected.apiVersion) {
    throw new StripeBoundaryError(
      "INVALID_API_VERSION",
      "Stripe webhook API version does not match the pinned adapter version",
      { httpStatus: 422 },
    );
  }
  if (event.livemode !== expected.livemode) {
    throw new StripeBoundaryError(
      "INVALID_EVENT_MODE",
      "Stripe event mode does not match this deployment",
      { httpStatus: 422 },
    );
  }
}
