import "server-only";

import type Stripe from "stripe";
import { getStripeRuntimeConfig } from "./client";
import { processStripeWebhookEvent } from "./processor";
import {
  assertStripeEventEnvelope,
  verifyStripeWebhookSignature,
} from "./signature";

export class StripeWebhookAdapter {
  constructor(private readonly config: {
    webhookSecret: string;
    apiVersion: string;
    livemode: boolean;
  }) {}

  async verify(rawBody: Uint8Array, headers: Headers): Promise<Stripe.Event> {
    const signature = headers.get("stripe-signature") ?? "";
    const event = await verifyStripeWebhookSignature(
      rawBody,
      signature,
      this.config.webhookSecret,
    );
    assertStripeEventEnvelope(event, {
      apiVersion: this.config.apiVersion,
      livemode: this.config.livemode,
    });
    return event;
  }

  async handle(rawBody: Uint8Array, headers: Headers) {
    const event = await this.verify(rawBody, headers);
    return processStripeWebhookEvent(event, rawBody);
  }
}

export function getStripeWebhookAdapter() {
  const config = getStripeRuntimeConfig();
  return new StripeWebhookAdapter({
    webhookSecret: config.webhookSecret,
    apiVersion: config.apiVersion,
    livemode: config.livemode,
  });
}
