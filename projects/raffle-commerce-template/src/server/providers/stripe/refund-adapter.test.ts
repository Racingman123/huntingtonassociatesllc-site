import { describe, expect, it, vi } from "vitest";
import { StripeSdkRefundBoundary } from "./refund-adapter-core";

describe("Stripe SDK refund boundary", () => {
  it("passes the PaymentIntent, amount, reason, metadata, and provider idempotency key exactly", async () => {
    const create = vi.fn(async () => ({ id: "re_123", status: "pending" }));
    const boundary = new StripeSdkRefundBoundary({ refunds: { create } } as never);
    const input = {
      providerPaymentId: "pi_123",
      amountCents: 1_250,
      reason: "requested_by_customer" as const,
      metadata: {
        giveaway_contract: "order-refund-v1" as const,
        giveaway_tenant_id: "tenant_1",
        giveaway_order_id: "order_1",
        giveaway_refund_id: "refund_1",
        giveaway_allocation_fingerprint: "a".repeat(64),
      },
      idempotencyKey: "refund:tenant_1:request_1",
    };
    await expect(boundary.createRefund(input)).resolves.toEqual({
      providerRefundId: "re_123",
      status: "pending",
    });
    expect(create).toHaveBeenCalledWith({
      payment_intent: "pi_123",
      amount: 1_250,
      reason: "requested_by_customer",
      metadata: input.metadata,
    }, { idempotencyKey: input.idempotencyKey });
  });
});
