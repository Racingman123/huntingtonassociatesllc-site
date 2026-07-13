export type StripeRefundReason = "duplicate" | "fraudulent" | "requested_by_customer";

export type CreateStripeRefundInput = {
  providerPaymentId: string;
  amountCents: number;
  reason: StripeRefundReason;
  metadata: {
    giveaway_contract: "order-refund-v1";
    giveaway_tenant_id: string;
    giveaway_order_id: string;
    giveaway_refund_id: string;
    giveaway_allocation_fingerprint: string;
  };
  idempotencyKey: string;
};

export type StripeRefundResult = {
  providerRefundId: string;
  status: string | null;
};

export interface StripeRefundBoundary {
  createRefund(input: CreateStripeRefundInput): Promise<StripeRefundResult>;
}

export type StripeRefundClient = {
  refunds: {
    create(
      input: {
        payment_intent: string;
        amount: number;
        reason: StripeRefundReason;
        metadata: CreateStripeRefundInput["metadata"];
      },
      options: { idempotencyKey: string },
    ): Promise<{ id: string; status: StripeRefundResult["status"] }>;
  };
};

export class StripeSdkRefundBoundary implements StripeRefundBoundary {
  constructor(private readonly client: StripeRefundClient) {}

  async createRefund(input: CreateStripeRefundInput): Promise<StripeRefundResult> {
    const refund = await this.client.refunds.create({
      payment_intent: input.providerPaymentId,
      amount: input.amountCents,
      reason: input.reason,
      metadata: input.metadata,
    }, { idempotencyKey: input.idempotencyKey });
    return { providerRefundId: refund.id, status: refund.status };
  }
}
