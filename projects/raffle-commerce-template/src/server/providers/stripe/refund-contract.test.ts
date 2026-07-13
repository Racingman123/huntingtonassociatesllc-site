import { describe, expect, it } from "vitest";
import {
  refundAllocationFingerprint,
  stripeRefundMetadata,
} from "./refund-contract";

describe("Stripe refund contract", () => {
  it("fingerprints allocations canonically and emits the exact v1 metadata", () => {
    const base = {
      tenantId: "tenant_1",
      orderId: "order_1",
      paymentId: "payment_1",
      amountCents: 1_250,
      merchandiseCents: 1_000,
      shippingCents: 200,
      taxCents: 50,
      currency: "USD",
    };
    const fingerprint = refundAllocationFingerprint({
      ...base,
      allocations: [
        { orderLineId: "line_b", amountCents: 400, entriesReversed: 40n },
        { orderLineId: "line_a", amountCents: 600, entriesReversed: 60n },
      ],
    });
    expect(refundAllocationFingerprint({
      ...base,
      allocations: [
        { orderLineId: "line_a", amountCents: 600, entriesReversed: 60n },
        { orderLineId: "line_b", amountCents: 400, entriesReversed: 40n },
      ],
    })).toBe(fingerprint);
    expect(stripeRefundMetadata({
      tenantId: base.tenantId,
      orderId: base.orderId,
      refundId: "refund_1",
      allocationFingerprint: fingerprint,
    })).toEqual({
      giveaway_contract: "order-refund-v1",
      giveaway_tenant_id: "tenant_1",
      giveaway_order_id: "order_1",
      giveaway_refund_id: "refund_1",
      giveaway_allocation_fingerprint: fingerprint,
    });
  });

  it("changes when a monetary category or entry consequence changes", () => {
    const input = {
      tenantId: "tenant_1",
      orderId: "order_1",
      paymentId: "payment_1",
      amountCents: 1_000,
      merchandiseCents: 1_000,
      shippingCents: 0,
      taxCents: 0,
      currency: "USD",
      allocations: [{ orderLineId: "line_1", amountCents: 1_000, entriesReversed: 100n }],
    };
    expect(refundAllocationFingerprint(input)).not.toBe(refundAllocationFingerprint({
      ...input,
      merchandiseCents: 0,
      shippingCents: 1_000,
      allocations: [],
    }));
  });
});
