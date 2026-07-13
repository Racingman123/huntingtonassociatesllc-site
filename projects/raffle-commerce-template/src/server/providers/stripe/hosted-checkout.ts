import "server-only";

import { getStripeClient } from "./client";
import {
  buildStripeCheckoutSessionParams,
  type PreparedStripeCheckoutRequest,
} from "./checkout-contract";
import { assertStripeHostedUrl } from "./hosted-url";

export interface StripeHostedCheckoutBoundary {
  createForPreparedOrder(input: PreparedStripeCheckoutRequest): Promise<{
    providerCheckoutId: string;
    redirectUrl: string;
  }>;
}

export class StripeHostedCheckoutAdapter implements StripeHostedCheckoutBoundary {
  constructor(private readonly client = getStripeClient()) {}

  async createForPreparedOrder(input: PreparedStripeCheckoutRequest) {
    const session = await this.client.checkout.sessions.create(
      buildStripeCheckoutSessionParams(input),
      { idempotencyKey: input.idempotencyKey },
    );
    return {
      providerCheckoutId: session.id,
      redirectUrl: assertStripeHostedUrl(session.url, ["checkout.stripe.com"]),
    };
  }
}

export function getStripeHostedCheckoutBoundary() {
  return new StripeHostedCheckoutAdapter();
}

export type StripeCheckoutSessionState = {
  status: "open" | "complete" | "expired" | null;
  paymentStatus: "paid" | "unpaid" | "no_payment_required";
};

/** Used by the expiry worker so it never releases a provider-paid session. */
export async function retrieveStripeCheckoutSessionState(
  providerCheckoutId: string,
): Promise<StripeCheckoutSessionState> {
  const session = await getStripeClient().checkout.sessions.retrieve(providerCheckoutId);
  return { status: session.status, paymentStatus: session.payment_status };
}
