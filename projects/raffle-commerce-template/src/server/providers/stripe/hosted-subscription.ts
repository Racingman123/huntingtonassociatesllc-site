import "server-only";

import type Stripe from "stripe";
import { getStripeClient } from "./client";
import {
  buildStripeSubscriptionCheckoutParams,
  type PreparedStripeSubscriptionRequest,
} from "./subscription-contract";
import { StripeBoundaryError } from "./errors";
import { assertStripeHostedUrl } from "./hosted-url";

export interface StripeHostedSubscriptionBoundary {
  createEnrollment(input: PreparedStripeSubscriptionRequest): Promise<{
    providerCheckoutId: string;
    redirectUrl: string;
  }>;
  createBillingPortal(input: {
    providerCustomerId: string;
    returnUrl: string;
    idempotencyKey: string;
  }): Promise<{ redirectUrl: string }>;
}

function recurringInterval(value: string): Stripe.Price.Recurring.Interval {
  const normalized = value.toLowerCase();
  if (!["day", "week", "month", "year"].includes(normalized)) {
    throw new StripeBoundaryError("CONFIGURATION_ERROR", "The local membership interval is unsupported", {
      httpStatus: 503,
    });
  }
  return normalized as Stripe.Price.Recurring.Interval;
}

export class StripeHostedSubscriptionAdapter implements StripeHostedSubscriptionBoundary {
  constructor(private readonly client = getStripeClient()) {}

  async createEnrollment(input: PreparedStripeSubscriptionRequest) {
    const price = await this.client.prices.retrieve(input.providerPriceId);
    if (
      !price.active
      || price.type !== "recurring"
      || !price.recurring
      || price.unit_amount !== input.priceCents
      || price.currency.toUpperCase() !== input.currency
      || price.recurring.interval !== recurringInterval(input.billingInterval)
      || price.recurring.interval_count !== input.billingIntervalCount
    ) {
      throw new StripeBoundaryError(
        "CONFIGURATION_ERROR",
        "The Stripe membership price does not match the authoritative local plan",
        { httpStatus: 503 },
      );
    }
    const session = await this.client.checkout.sessions.create(
      buildStripeSubscriptionCheckoutParams(input),
      { idempotencyKey: input.providerIdempotencyKey },
    );
    return {
      providerCheckoutId: session.id,
      redirectUrl: assertStripeHostedUrl(session.url, ["checkout.stripe.com"]),
    };
  }

  async createBillingPortal(input: {
    providerCustomerId: string;
    returnUrl: string;
    idempotencyKey: string;
  }) {
    const session = await this.client.billingPortal.sessions.create(
      { customer: input.providerCustomerId, return_url: input.returnUrl },
      { idempotencyKey: input.idempotencyKey },
    );
    return { redirectUrl: assertStripeHostedUrl(session.url, ["billing.stripe.com"]) };
  }
}

export function getStripeHostedSubscriptionBoundary() {
  return new StripeHostedSubscriptionAdapter();
}
