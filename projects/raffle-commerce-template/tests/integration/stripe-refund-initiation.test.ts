import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test, vi } from "vitest";
import { completeDemoCheckout } from "@/server/commerce/checkout";
import { db } from "@/server/db";
import type { StripeRefundBoundary } from "@/server/providers/stripe/refund-adapter-core";
import {
  failStripeRefund,
  initiateStripeRefund,
  settleDemoRefund,
  settleRefund,
} from "@/server/refunds/service";
import {
  checkoutInput,
  createProduct,
  createPromotion,
  createStaff,
} from "./fixtures";

afterAll(async () => {
  await db.$disconnect();
});

async function stripeOrder(options: { priceCents: number; physical?: boolean; email: string }) {
  const { tenant } = await createPromotion({ multiplier: 10 });
  const product = await createProduct({
    tenantId: tenant.id,
    priceCents: options.priceCents,
    productType: options.physical ? "PHYSICAL" : "DIGITAL",
  });
  const checkout = await completeDemoCheckout(checkoutInput({
    email: options.email,
    lines: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1 }],
  }), tenant.slug);
  const order = await db.order.findFirstOrThrow({
    where: { tenantId: tenant.id, orderNumber: checkout.orderNumber },
    include: { payments: true },
  });
  const payment = order.payments[0]!;
  await db.order.update({ where: { id: order.id }, data: { provider: "STRIPE" } });
  await db.payment.update({
    where: { id: payment.id },
    data: { provider: "STRIPE", providerPaymentId: `pi_${randomUUID()}` },
  });
  return {
    tenant,
    checkout,
    order: await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } }),
  };
}

function boundary(providerRefundId: string) {
  const createRefund = vi.fn(async () => ({ providerRefundId, status: "pending" }));
  return { adapter: { createRefund } satisfies StripeRefundBoundary, createRefund };
}

async function providerSettle(refund: Awaited<ReturnType<typeof initiateStripeRefund>>, providerPaymentId: string) {
  return settleRefund({
    tenantId: refund.tenantId,
    orderId: refund.orderId,
    refundId: refund.id,
    allocationFingerprint: refund.allocationFingerprint,
    provider: "STRIPE",
    providerPaymentId,
    providerRefundId: refund.providerRefundId,
    amountCents: refund.amountCents,
    currency: refund.currency,
    reason: "Stripe refund settled: requested_by_customer",
    actorType: "PAYMENT_PROVIDER",
    actorId: "STRIPE",
    occurredAt: new Date(),
    idempotencyKey: `stripe-refund:${refund.providerRefundId}`,
  });
}

describe.sequential("authorized Stripe refund initiation", () => {
  test("demo refunds honor an explicit shipping-only allocation", async () => {
    const { tenant } = await createPromotion({ multiplier: 10 });
    const product = await createProduct({ tenantId: tenant.id, priceCents: 10_000, productType: "PHYSICAL" });
    const checkout = await completeDemoCheckout(checkoutInput({
      email: "demo-shipping-only@example.test",
      lines: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1 }],
    }), tenant.slug);
    const order = await db.order.findFirstOrThrow({ where: { tenantId: tenant.id, orderNumber: checkout.orderNumber } });
    const refund = await settleDemoRefund({
      orderId: order.id,
      amountCents: order.shippingCents,
      merchandiseCents: 0,
      shippingCents: order.shippingCents,
      taxCents: 0,
      reason: "Explicit demo shipping-only refund allocation.",
      actorId: "demo-refund-operator",
      idempotencyKey: `demo-shipping:${randomUUID()}`,
    });
    expect(refund.allocations).toHaveLength(0);
    expect((await db.entryAccount.findFirstOrThrow({ where: { tenantId: tenant.id } })).balance)
      .toBe(checkout.entries);
  });

  test("shipping-only allocation replays without a second provider call and reverses zero entries", async () => {
    const { tenant, checkout, order } = await stripeOrder({
      priceCents: 10_000,
      physical: true,
      email: "stripe-shipping-refund@example.test",
    });
    const operator = await createStaff(tenant.id, "OPERATIONS");
    const provider = boundary(`re_${randomUUID()}`);
    const idempotencyKey = `shipping-only:${randomUUID()}`;
    const input = {
      tenantId: tenant.id,
      orderId: order.id,
      actorId: operator.id,
      amountCents: 1_200,
      merchandiseCents: 0,
      shippingCents: 1_200,
      taxCents: 0,
      reason: "Outbound shipping was refunded under the approved return case.",
      evidence: "support-case://shipping-123",
      providerReason: "requested_by_customer" as const,
      idempotencyKey,
    };
    const first = await initiateStripeRefund(input, provider.adapter);
    const replay = await initiateStripeRefund(input, provider.adapter);
    expect(replay.id).toBe(first.id);
    expect(provider.createRefund).toHaveBeenCalledTimes(1);
    expect(provider.createRefund).toHaveBeenCalledWith(expect.objectContaining({
      providerPaymentId: order.payments[0]!.providerPaymentId,
      amountCents: 1_200,
      metadata: {
        giveaway_contract: "order-refund-v1",
        giveaway_tenant_id: tenant.id,
        giveaway_order_id: order.id,
        giveaway_refund_id: first.id,
        giveaway_allocation_fingerprint: first.allocationFingerprint,
      },
    }));
    expect(first.allocations).toHaveLength(0);

    const settled = await providerSettle(first, order.payments[0]!.providerPaymentId!);
    expect(settled).toMatchObject({ status: "COMPLETED", merchandiseCents: 0, shippingCents: 1_200 });
    expect((await db.entryAccount.findFirstOrThrow({ where: { tenantId: tenant.id } })).balance)
      .toBe(checkout.entries);
    expect(await db.entryLedgerEvent.count({
      where: { tenantId: tenant.id, kind: "REVERSAL" },
    })).toBe(0);
    await expect(settleRefund({
      tenantId: first.tenantId,
      orderId: first.orderId,
      refundId: first.id,
      allocationFingerprint: first.allocationFingerprint,
      provider: "STRIPE",
      providerPaymentId: order.payments[0]!.providerPaymentId,
      providerRefundId: first.providerRefundId,
      amountCents: 1_201,
      currency: first.currency,
      reason: "Conflicting provider amount must be rejected",
      actorType: "PAYMENT_PROVIDER",
      actorId: "STRIPE",
      occurredAt: new Date(),
      idempotencyKey: `stripe-refund-conflict:${randomUUID()}`,
    })).rejects.toThrow(/conflicts/i);
  });

  test("partial merchandise refunds converge to the original entry grant", async () => {
    const { tenant, order } = await stripeOrder({
      priceCents: 10_000,
      email: "stripe-merchandise-refund@example.test",
    });
    const administrator = await createStaff(tenant.id, "ADMIN");
    for (const [index, amountCents] of [4_000, 6_000].entries()) {
      const provider = boundary(`re_merch_${index}_${randomUUID()}`);
      const refund = await initiateStripeRefund({
        tenantId: tenant.id,
        orderId: order.id,
        actorId: administrator.id,
        amountCents,
        merchandiseCents: amountCents,
        shippingCents: 0,
        taxCents: 0,
        reason: `Approved merchandise refund portion ${index + 1}.`,
        evidence: `rma://merchandise-${index + 1}`,
        providerReason: "requested_by_customer",
        idempotencyKey: `merchandise-refund:${index}:${randomUUID()}`,
      }, provider.adapter);
      await providerSettle(refund, order.payments[0]!.providerPaymentId!);
    }
    expect((await db.entryAccount.findFirstOrThrow({ where: { tenantId: tenant.id } })).balance).toBe(0n);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe("REFUNDED");
    const allocations = await db.refundLineAllocation.findMany({ where: { refund: { orderId: order.id } } });
    expect(allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0)).toBe(10_000);
    expect(allocations.reduce((sum, allocation) => sum + allocation.entriesReversed, 0n)).toBe(1_000n);
  });

  test("terminal provider failure releases the allocation and authorizes a fresh retry", async () => {
    const { tenant, order } = await stripeOrder({
      priceCents: 5_000,
      email: "stripe-failed-refund@example.test",
    });
    const operator = await createStaff(tenant.id, "OPERATIONS");
    const firstProvider = boundary(`re_failed_${randomUUID()}`);
    const request = {
      tenantId: tenant.id,
      orderId: order.id,
      actorId: operator.id,
      amountCents: 2_000,
      merchandiseCents: 2_000,
      shippingCents: 0,
      taxCents: 0,
      reason: "The first provider refund attempt is expected to fail safely.",
      evidence: "support-case://failed-refund-1",
      providerReason: "requested_by_customer" as const,
      idempotencyKey: `failed-refund:${randomUUID()}`,
    };
    const first = await initiateStripeRefund(request, firstProvider.adapter);
    const failureInput = {
      tenantId: tenant.id,
      orderId: order.id,
      refundId: first.id,
      allocationFingerprint: first.allocationFingerprint,
      providerPaymentId: order.payments[0]!.providerPaymentId!,
      providerRefundId: first.providerRefundId!,
      providerEventId: `evt_refund_failed_${randomUUID()}`,
      amountCents: first.amountCents,
      currency: first.currency,
      providerStatus: "failed" as const,
      failureReason: "Stripe refund failed: insufficient_funds",
      occurredAt: new Date(),
    };
    const failed = await failStripeRefund(failureInput);
    const replay = await failStripeRefund(failureInput);
    expect(failed).toMatchObject({ status: "FAILED", providerStatus: "failed", idempotent: false });
    expect(replay).toMatchObject({ id: first.id, status: "FAILED", idempotent: true });
    expect(await db.auditEvent.findFirstOrThrow({
      where: { tenantId: tenant.id, resourceType: "Refund", resourceId: first.id },
      orderBy: { createdAt: "desc" },
    })).toMatchObject({ action: "STRIPE_REFUND_FAILED", reason: failureInput.failureReason });

    await expect(failStripeRefund({ ...failureInput, amountCents: 2_001 }))
      .rejects.toThrow(/conflicts/i);

    const retryProvider = boundary(`re_retry_${randomUUID()}`);
    const retry = await initiateStripeRefund({
      ...request,
      evidence: "support-case://failed-refund-1-retry",
      idempotencyKey: `failed-refund-retry:${randomUUID()}`,
    }, retryProvider.adapter);
    expect(retry).toMatchObject({ status: "PROCESSING", amountCents: 2_000 });
    expect(retry.id).not.toBe(first.id);
    expect(retryProvider.createRefund).toHaveBeenCalledTimes(1);
    expect(await db.refund.count({ where: { orderId: order.id } })).toBe(2);
  });

  test("a terminal create response is recorded immediately instead of stranding PROCESSING", async () => {
    const { tenant, order } = await stripeOrder({
      priceCents: 4_000,
      email: "stripe-canceled-refund@example.test",
    });
    const operator = await createStaff(tenant.id, "ADMIN");
    const providerRefundId = `re_canceled_${randomUUID()}`;
    const adapter = {
      createRefund: vi.fn(async () => ({ providerRefundId, status: "canceled" })),
    } satisfies StripeRefundBoundary;
    const refund = await initiateStripeRefund({
      tenantId: tenant.id,
      orderId: order.id,
      actorId: operator.id,
      amountCents: 1_000,
      merchandiseCents: 1_000,
      shippingCents: 0,
      taxCents: 0,
      reason: "Stripe returned a terminal cancellation during refund creation.",
      evidence: "support-case://canceled-create-response",
      providerReason: "requested_by_customer",
      idempotencyKey: `canceled-refund:${randomUUID()}`,
    }, adapter);
    expect(refund).toMatchObject({
      status: "FAILED",
      providerRefundId,
      providerStatus: "canceled",
      failureReason: "Stripe refund creation returned terminal status canceled",
    });
  });

  test("rejects cross-tenant and non-operator actors before calling Stripe", async () => {
    const { tenant, order } = await stripeOrder({ priceCents: 5_000, email: "stripe-role-refund@example.test" });
    const compliance = await createStaff(tenant.id, "COMPLIANCE");
    const { tenant: otherTenant } = await createPromotion();
    const otherOperator = await createStaff(otherTenant.id, "OPERATIONS");
    const provider = boundary(`re_forbidden_${randomUUID()}`);
    const base = {
      tenantId: tenant.id,
      orderId: order.id,
      amountCents: 1_000,
      merchandiseCents: 1_000,
      shippingCents: 0,
      taxCents: 0,
      reason: "Role and tenant boundaries must be enforced.",
      evidence: "case://forbidden",
      providerReason: "requested_by_customer" as const,
    };
    await expect(initiateStripeRefund({
      ...base,
      actorId: compliance.id,
      idempotencyKey: `compliance:${randomUUID()}`,
    }, provider.adapter)).rejects.toThrow(/operator/i);
    await expect(initiateStripeRefund({
      ...base,
      actorId: otherOperator.id,
      idempotencyKey: `cross-tenant:${randomUUID()}`,
    }, provider.adapter)).rejects.toThrow(/operator/i);
    expect(provider.createRefund).not.toHaveBeenCalled();
  });
});
