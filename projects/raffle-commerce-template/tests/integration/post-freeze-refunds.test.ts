import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { completeDemoCheckout } from "@/server/commerce/checkout";
import { db } from "@/server/db";
import { approveEntrySnapshot, buildEntrySnapshot, conductDemoDraw } from "@/server/draws/operations";
import {
  approveAdjustmentEvidence,
  decideAdjustmentCompliance,
} from "@/server/refunds/adjustments";
import { settleDemoRefund } from "@/server/refunds/service";
import {
  decideDrawCandidate,
  publishVerifiedWinner,
  recordCandidateContact,
} from "@/server/winners/service";
import {
  checkoutInput,
  createProduct,
  createPromotion,
  createStaff,
  releasePromotionFixture,
} from "./fixtures";

afterAll(async () => {
  await db.$disconnect();
});

async function closeAndSeal(campaignId: string, operationsId: string, complianceId: string) {
  await db.campaign.update({
    where: { id: campaignId },
    data: {
      status: "ENTRY_CLOSED",
      endsAt: new Date(Date.now() - 2_000),
      freeEntryEndsAt: new Date(Date.now() - 2_000),
    },
  });
  await releasePromotionFixture(campaignId);
  const built = await buildEntrySnapshot(campaignId, operationsId);
  await approveEntrySnapshot({
    snapshotId: built.snapshot.id,
    actorId: operationsId,
    kind: "OPERATIONS_RECONCILIATION",
    notes: "Operations reconciled the refund queue and entry ledger.",
  });
  await approveEntrySnapshot({
    snapshotId: built.snapshot.id,
    actorId: complianceId,
    kind: "COMPLIANCE_WITNESS",
    notes: "Compliance independently witnessed the sealed population.",
  });
  return db.entrySnapshot.findUniqueOrThrow({ where: { id: built.snapshot.id } });
}

describe.sequential("post-freeze refund entry consequences", () => {
  test("a full refund with shipping allocates all merchandise entries and keeps monetary totals exact", async () => {
    const { tenant } = await createPromotion({ multiplier: 10 });
    const product = await createProduct({
      tenantId: tenant.id,
      priceCents: 10_000,
      productType: "PHYSICAL",
    });
    const checkout = await completeDemoCheckout(checkoutInput({
      email: "shipping-refund@example.test",
      lines: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1 }],
    }), tenant.slug);
    const order = await db.order.findFirstOrThrow({
      where: { tenantId: tenant.id, orderNumber: checkout.orderNumber },
    });
    expect(order).toMatchObject({ subtotalCents: 10_000, shippingCents: 1_200, totalCents: 11_200 });

    const refund = await settleDemoRefund({
      orderId: order.id,
      amountCents: order.totalCents,
      reason: "The complete order, including outbound shipping, was refunded.",
      actorId: "aggregate-refund-test",
      idempotencyKey: `shipping-full-refund:${randomUUID()}`,
    });
    expect(refund.amountCents).toBe(11_200);
    expect(refund.allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0)).toBe(10_000);
    expect(refund.allocations.reduce((sum, allocation) => sum + allocation.entriesReversed, 0n)).toBe(1_000n);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe("REFUNDED");
    expect((await db.payment.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe("REFUNDED");
    expect((await db.entryAccount.findFirstOrThrow({ where: { tenantId: tenant.id } })).balance).toBe(0n);
  });

  test("dual approval voids the pre-draw snapshot and applies an append-only reversal", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 10, drawReady: true });
    const operations = await createStaff(tenant.id, "OPERATIONS");
    const compliance = await createStaff(tenant.id, "COMPLIANCE");
    const product = await createProduct({ tenantId: tenant.id, priceCents: 10_000 });
    const checkout = await completeDemoCheckout(checkoutInput({
      email: "pre-draw-adjustment@example.test",
      lines: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1 }],
    }), tenant.slug);
    const order = await db.order.findFirstOrThrow({
      where: { tenantId: tenant.id, orderNumber: checkout.orderNumber },
    });
    const sealed = await closeAndSeal(campaign.id, operations.id, compliance.id);
    const balanceBefore = (await db.entryAccount.findFirstOrThrow({ where: { campaignId: campaign.id } })).balance;

    const refund = await settleDemoRefund({
      orderId: order.id,
      amountCents: 5_000,
      reason: "Half of the merchandise amount was returned after sealing.",
      actorId: operations.id,
      idempotencyKey: `post-freeze-refund:${randomUUID()}`,
    });
    const request = await db.entryAdjustmentRequest.findUniqueOrThrow({
      where: { refundId: refund.id },
      include: { approvals: true },
    });
    expect(request).toMatchObject({
      tenantId: tenant.id,
      campaignId: campaign.id,
      status: "PENDING",
      delta: -500n,
    });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe("PARTIALLY_REFUNDED");
    expect((await db.payment.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe("PARTIALLY_REFUNDED");
    expect((await db.entryAccount.findFirstOrThrow({ where: { campaignId: campaign.id } })).balance).toBe(balanceBefore);

    const evidenceInput = {
      tenantId: tenant.id,
      requestId: request.id,
      actorId: operations.id,
      evidenceRef: `provider-refund://${refund.providerRefundId}`,
      notes: "Verified provider settlement, refund amount, allocation, order, and entrant identity.",
    };
    expect(await approveAdjustmentEvidence(evidenceInput)).toMatchObject({ idempotent: false });
    expect(await approveAdjustmentEvidence(evidenceInput)).toMatchObject({ idempotent: true });
    const immutableEvidence = await db.entryAdjustmentApproval.findFirstOrThrow({
      where: { requestId: request.id, kind: "EVIDENCE_REVIEW" },
    });
    await expect(db.entryAdjustmentApproval.update({
      where: { id: immutableEvidence.id },
      data: { notes: "Attempted mutation of approved evidence." },
    })).rejects.toThrow();

    const decisionInput = {
      tenantId: tenant.id,
      requestId: request.id,
      actorId: compliance.id,
      disposition: "REVERSE_BEFORE_DRAW" as const,
      notes: "Compliance approves reversal and requires a replacement snapshot before selection.",
    };
    expect(await decideAdjustmentCompliance(decisionInput)).toMatchObject({ idempotent: false });
    expect(await decideAdjustmentCompliance(decisionInput)).toMatchObject({ idempotent: true });

    expect(await db.entrySnapshot.findUniqueOrThrow({ where: { id: sealed.id } }))
      .toMatchObject({ status: "VOID" });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } }))
      .toMatchObject({ status: "RECONCILING" });
    const applied = await db.entryAdjustmentRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(applied).toMatchObject({
      status: "APPLIED",
      disposition: "REVERSE_BEFORE_DRAW",
      reviewedBy: compliance.id,
    });
    expect(applied.appliedAt).not.toBeNull();
    const account = await db.entryAccount.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(account.balance).toBe(balanceBefore - 500n);
    expect(await db.entryLedgerEvent.findMany({
      where: { entryAccountId: account.id, reasonCode: "APPROVED_POST_FREEZE_REFUND_REVERSAL" },
    })).toEqual([expect.objectContaining({ delta: -500n })]);

    const replacement = await buildEntrySnapshot(campaign.id, operations.id);
    expect(replacement.snapshot).toMatchObject({ version: 2, status: "AWAITING_APPROVAL", totalEntries: 500n });
  });

  test("post-draw cases block winner steps until preserve or disqualify disposition", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 10, drawReady: true });
    await db.campaignPrize.create({
      data: {
        tenantId: tenant.id,
        campaignId: campaign.id,
        name: "Post-draw adjustment test prize",
        description: "A disposable prize used to exercise winner controls.",
        approximateValueCents: 100_000,
        currency: tenant.currency,
      },
    });
    const operations = await createStaff(tenant.id, "OPERATIONS");
    const compliance = await createStaff(tenant.id, "COMPLIANCE");
    const administrator = await createStaff(tenant.id, "ADMIN");
    const product = await createProduct({ tenantId: tenant.id, priceCents: 10_000 });
    const checkout = await completeDemoCheckout(checkoutInput({
      email: "post-draw-adjustment@example.test",
      lines: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1 }],
    }), tenant.slug);
    const order = await db.order.findFirstOrThrow({
      where: { tenantId: tenant.id, orderNumber: checkout.orderNumber },
    });
    const sealed = await closeAndSeal(campaign.id, operations.id, compliance.id);
    const draw = await conductDemoDraw(sealed.id, operations.id, 1);
    const candidate = draw.candidates[0]!;
    await recordCandidateContact({
      tenantId: tenant.id,
      candidateId: candidate.id,
      actorId: operations.id,
      contactDeadline: new Date(Date.now() + 7 * 86_400_000),
    });

    const firstRefund = await settleDemoRefund({
      orderId: order.id,
      amountCents: 2_000,
      reason: "First provider refund arrived after candidate selection.",
      actorId: operations.id,
      idempotencyKey: `post-draw-preserve:${randomUUID()}`,
    });
    const preserveCase = await db.entryAdjustmentRequest.findUniqueOrThrow({ where: { refundId: firstRefund.id } });
    await expect(decideDrawCandidate({
      tenantId: tenant.id,
      candidateId: candidate.id,
      actorId: compliance.id,
      decision: "VERIFY",
      reason: "Identity, residency, age, and campaign eligibility were verified.",
    })).rejects.toThrow(/entry cases must be resolved before winner verification/i);
    await approveAdjustmentEvidence({
      tenantId: tenant.id,
      requestId: preserveCase.id,
      actorId: operations.id,
      evidenceRef: `provider-refund://${firstRefund.providerRefundId}`,
      notes: "Operations verified the first post-draw provider refund evidence and allocation.",
    });
    await decideAdjustmentCompliance({
      tenantId: tenant.id,
      requestId: preserveCase.id,
      actorId: compliance.id,
      disposition: "PRESERVE_RESULT",
      notes: "The approved rules preserve this completed selection despite the later refund.",
    });
    const verified = await decideDrawCandidate({
      tenantId: tenant.id,
      candidateId: candidate.id,
      actorId: compliance.id,
      decision: "VERIFY",
      reason: "Identity, residency, age, and campaign eligibility were verified.",
    });

    const secondRefund = await settleDemoRefund({
      orderId: order.id,
      amountCents: 2_000,
      reason: "Second provider refund requires a winner publication disposition.",
      actorId: operations.id,
      idempotencyKey: `post-draw-disqualify:${randomUUID()}`,
    });
    const disqualifyCase = await db.entryAdjustmentRequest.findUniqueOrThrow({ where: { refundId: secondRefund.id } });
    const publication = {
      tenantId: tenant.id,
      winnerId: verified.winner!.id,
      actorId: administrator.id,
      publicName: "Adjustment Test Winner",
      publicLocation: "Denver, CO",
      publicationConsentConfirmed: true as const,
    };
    await expect(publishVerifiedWinner(publication))
      .rejects.toThrow(/entry cases must be resolved before winner publication/i);
    await approveAdjustmentEvidence({
      tenantId: tenant.id,
      requestId: disqualifyCase.id,
      actorId: operations.id,
      evidenceRef: `provider-refund://${secondRefund.providerRefundId}`,
      notes: "Operations verified the second post-draw refund and entrant relationship.",
    });
    await decideAdjustmentCompliance({
      tenantId: tenant.id,
      requestId: disqualifyCase.id,
      actorId: compliance.id,
      disposition: "DISQUALIFY_ENTRANT",
      notes: "The official rules require disqualification after this documented refund event.",
    });
    expect(await db.campaignEntrant.findFirstOrThrow({
      where: { campaignId: campaign.id, entrantId: order.entrantId },
    })).toMatchObject({ status: "DISQUALIFIED" });
    await expect(publishVerifiedWinner(publication)).rejects.toThrow(/no longer eligible/i);

    const account = await db.entryAccount.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(account.balance).toBe(1_000n);
    expect(await db.entryLedgerEvent.count({ where: { entryAccountId: account.id, kind: "REVERSAL" } })).toBe(0);
    expect(await db.entrySnapshot.findUniqueOrThrow({ where: { id: sealed.id } })).toMatchObject({ status: "SEALED" });
    expect(await db.entryAdjustmentRequest.findMany({
      where: { id: { in: [preserveCase.id, disqualifyCase.id] } },
      orderBy: { createdAt: "asc" },
    })).toEqual([
      expect.objectContaining({ status: "RESOLVED", disposition: "PRESERVE_RESULT" }),
      expect.objectContaining({ status: "RESOLVED", disposition: "DISQUALIFY_ENTRANT" }),
    ]);
  });
});
