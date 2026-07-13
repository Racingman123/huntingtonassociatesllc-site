import { createHash } from "node:crypto";
import { z } from "zod";

export const STRIPE_REFUND_METADATA_CONTRACT = "order-refund-v1";

const databaseId = z.string().trim().min(1).max(191);

export const stripeRefundMetadataSchema = z.object({
  giveaway_contract: z.literal(STRIPE_REFUND_METADATA_CONTRACT),
  giveaway_tenant_id: databaseId,
  giveaway_order_id: databaseId,
  giveaway_refund_id: databaseId,
  giveaway_allocation_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type RefundAllocationFingerprintInput = {
  tenantId: string;
  orderId: string;
  paymentId: string;
  amountCents: number;
  merchandiseCents: number;
  shippingCents: number;
  taxCents: number;
  currency: string;
  allocations: Array<{
    orderLineId: string;
    amountCents: number;
    entriesReversed: bigint;
  }>;
};

/** Fingerprints the immutable monetary and entry allocation approved by staff. */
export function refundAllocationFingerprint(input: RefundAllocationFingerprintInput) {
  const canonical = {
    contract: STRIPE_REFUND_METADATA_CONTRACT,
    tenantId: input.tenantId,
    orderId: input.orderId,
    paymentId: input.paymentId,
    amountCents: input.amountCents,
    merchandiseCents: input.merchandiseCents,
    shippingCents: input.shippingCents,
    taxCents: input.taxCents,
    currency: input.currency,
    allocations: [...input.allocations]
      .sort((left, right) => left.orderLineId.localeCompare(right.orderLineId))
      .map((allocation) => ({
        orderLineId: allocation.orderLineId,
        amountCents: allocation.amountCents,
        entriesReversed: allocation.entriesReversed.toString(),
      })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function stripeRefundMetadata(input: {
  tenantId: string;
  orderId: string;
  refundId: string;
  allocationFingerprint: string;
}) {
  return stripeRefundMetadataSchema.parse({
    giveaway_contract: STRIPE_REFUND_METADATA_CONTRACT,
    giveaway_tenant_id: input.tenantId,
    giveaway_order_id: input.orderId,
    giveaway_refund_id: input.refundId,
    giveaway_allocation_fingerprint: input.allocationFingerprint,
  });
}
