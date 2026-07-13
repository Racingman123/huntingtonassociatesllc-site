import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { completeDemoCheckout } from "@/server/commerce/checkout";
import { db } from "@/server/db";
import { approveEntrySnapshot, buildEntrySnapshot, conductDemoDraw } from "@/server/draws/operations";
import { createStripeSubscriptionFingerprint } from "@/server/providers/stripe/subscription-contract";
import { approveAdjustmentEvidence, decideAdjustmentCompliance } from "@/server/refunds/adjustments";
import { settleDemoRefund } from "@/server/refunds/service";
import { settleStripeSubscriptionInvoice } from "@/server/subscriptions/stripe-service";
import {
  decideDrawCandidate,
  publishVerifiedWinner,
  recordCandidateContact,
  recordWinnerFulfillment,
} from "@/server/winners/service";
import {
  checkoutInput,
  createEntrantAccount,
  createProduct,
  createPromotion,
  createStaff,
  releasePromotionFixture,
} from "./fixtures";

afterAll(async () => db.$disconnect());

async function createMembership(input: {
  tenantId: string;
  campaignId: string;
  occurredAt: Date;
  fixedEntries?: bigint;
  acceptRules?: boolean;
  identity?: {
    user: { id: string; email: string; name: string };
    entrant: { id: string; userId: string | null };
  };
}) {
  const product = await createProduct({
    tenantId: input.tenantId,
    priceCents: 2_500,
    productType: "MEMBERSHIP",
  });
  const email = input.identity?.user.email ?? `late-member-${randomUUID()}@example.test`;
  const user = input.identity?.user ?? await db.user.create({
    data: {
      tenantId: input.tenantId,
      email,
      normalizedEmail: email,
      name: "Late Invoice Member",
      passwordHash: "integration-only",
      role: "CUSTOMER",
      status: "ACTIVE",
    },
  });
  const entrant = input.identity?.entrant ?? await db.entrant.create({
    data: {
      tenantId: input.tenantId,
      userId: user.id,
      normalizedEmail: email,
      emailHash: createHash("sha256").update(email).digest("hex"),
      name: user.name,
      country: "US",
      region: "CO",
      postalCode: "80202",
      eligibilityAttested: true,
    },
  });
  const plan = await db.subscriptionPlan.create({
    data: {
      tenantId: input.tenantId,
      productId: product.id,
      name: "Late invoice plan",
      interval: "MONTH",
      intervalCount: 1,
      priceCents: 2_500,
      currency: "USD",
      baseEntries: input.fixedEntries ?? 100n,
      providerPriceId: `price_${randomUUID()}`,
    },
  });
  await db.membershipEntryBand.create({
    data: {
      campaignId: input.campaignId,
      planId: plan.id,
      minimumSettledCycles: 0,
      fixedEntries: input.fixedEntries ?? 100n,
    },
  });
  const subscriptionId = randomUUID();
  const checkoutExpiresAt = new Date(input.occurredAt.getTime() + 35 * 60_000);
  const enrollmentIdempotencyKey = `enroll:${randomUUID()}`;
  const periodStartsAt = new Date(input.occurredAt.getTime() - 24 * 60 * 60_000);
  const periodEndsAt = new Date(periodStartsAt.getTime() + 30 * 24 * 60 * 60_000);
  const facts = {
    tenantId: input.tenantId,
    subscriptionId,
    planId: plan.id,
    userId: user.id,
    entrantId: entrant.id,
    providerPriceId: plan.providerPriceId!,
    priceCents: plan.priceCents,
    currency: plan.currency,
    billingInterval: "MONTH",
    billingIntervalCount: 1,
    enrollmentIdempotencyKey,
    checkoutExpiresAt: checkoutExpiresAt.toISOString(),
  };
  const fingerprint = createStripeSubscriptionFingerprint(facts);
  const providerSubscriptionId = `sub_${randomUUID()}`;
  const providerCustomerId = `cus_${randomUUID()}`;
  const subscription = await db.subscription.create({
    data: {
      id: subscriptionId,
      tenantId: input.tenantId,
      planId: plan.id,
      userId: user.id,
      entrantId: entrant.id,
      status: "PENDING",
      provider: "STRIPE",
      providerSubscriptionId,
      providerCustomerId,
      providerPriceId: plan.providerPriceId,
      enrollmentIdempotencyKey,
      enrollmentFingerprint: fingerprint,
      enrollmentLockKey: `lock:${randomUUID()}`,
      checkoutExpiresAt,
      priceCents: plan.priceCents,
      currency: plan.currency,
      billingInterval: "MONTH",
      billingIntervalCount: 1,
      continuousSince: periodStartsAt,
      currentPeriodStartsAt: periodStartsAt,
      currentPeriodEndsAt: periodEndsAt,
    },
  });
  const invoice = {
    tenantId: input.tenantId,
    subscriptionId: subscription.id,
    subscriptionFingerprint: fingerprint,
    providerSubscriptionId,
    providerCustomerId,
    providerInvoiceId: `in_${randomUUID()}`,
    providerPaymentId: `pi_${randomUUID()}`,
    providerEventId: `evt_${randomUUID()}`,
    providerPriceId: plan.providerPriceId!,
    billingReason: "subscription_create" as const,
    capturedAmountCents: plan.priceCents,
    currency: plan.currency,
    periodStartsAt,
    periodEndsAt,
    occurredAt: input.occurredAt,
    payloadHash: createHash("sha256").update(randomUUID()).digest("hex"),
    idempotencyKey: `invoice:${randomUUID()}`,
  };
  if (input.acceptRules !== false) {
    const campaign = await db.campaign.findUniqueOrThrow({
      where: { id: input.campaignId },
      select: { officialRulesDocumentId: true, officialRulesChecksum: true },
    });
    if (!campaign.officialRulesDocumentId || !campaign.officialRulesChecksum) {
      throw new Error("Membership test campaign is missing an exact Official Rules binding");
    }
    await db.rulesAcceptance.upsert({
      where: {
        campaignId_entrantId_legalDocumentId_method: {
          campaignId: input.campaignId,
          entrantId: entrant.id,
          legalDocumentId: campaign.officialRulesDocumentId,
          method: "MEMBERSHIP",
        },
      },
      update: {},
      create: {
        tenantId: input.tenantId,
        campaignId: input.campaignId,
        entrantId: entrant.id,
        legalDocumentId: campaign.officialRulesDocumentId,
        documentChecksum: campaign.officialRulesChecksum,
        method: "MEMBERSHIP",
      },
    });
  }
  return { subscription, user, entrant, invoice };
}

async function closeAndSeal(input: {
  campaignId: string;
  operationsId: string;
  complianceId: string;
  cutoffAt: Date;
}) {
  await db.campaign.update({
    where: { id: input.campaignId },
    data: { status: "ENTRY_CLOSED", endsAt: input.cutoffAt, freeEntryEndsAt: input.cutoffAt },
  });
  await releasePromotionFixture(input.campaignId);
  const built = await buildEntrySnapshot(input.campaignId, input.operationsId);
  await approveEntrySnapshot({
    snapshotId: built.snapshot.id,
    actorId: input.operationsId,
    kind: "OPERATIONS_RECONCILIATION",
    notes: "Operations reconciled all provider, payment, and entry queues.",
  });
  await approveEntrySnapshot({
    snapshotId: built.snapshot.id,
    actorId: input.complianceId,
    kind: "COMPLIANCE_WITNESS",
    notes: "Compliance independently witnessed the frozen entry population.",
  });
  return db.entrySnapshot.findUniqueOrThrow({ where: { id: built.snapshot.id } });
}

type MembershipInvoice = Omit<
  Awaited<ReturnType<typeof createMembership>>["invoice"],
  "billingReason"
> & { billingReason: "subscription_create" | "subscription_cycle" };

function nextPaidInvoice(
  prior: MembershipInvoice,
  sequence: number,
) {
  const periodStartsAt = new Date(prior.periodEndsAt);
  const periodEndsAt = new Date(periodStartsAt.getTime() + 30 * 24 * 60 * 60_000);
  return {
    ...prior,
    providerInvoiceId: `in_${randomUUID()}`,
    providerPaymentId: `pi_${randomUUID()}`,
    providerEventId: `evt_${randomUUID()}`,
    billingReason: "subscription_cycle" as const,
    periodStartsAt,
    periodEndsAt,
    occurredAt: new Date(prior.occurredAt.getTime() + sequence * 1_000),
    payloadHash: createHash("sha256").update(randomUUID()).digest("hex"),
    idempotencyKey: `invoice:${randomUUID()}`,
  };
}

async function approveCase(input: {
  tenantId: string;
  requestId: string;
  operationsId: string;
  complianceId: string;
  disposition: "APPLY_BEFORE_DRAW" | "VOID_DRAW_AND_REBUILD";
}) {
  await approveAdjustmentEvidence({
    tenantId: input.tenantId,
    requestId: input.requestId,
    actorId: input.operationsId,
    evidenceRef: `stripe-evidence://${randomUUID()}`,
    notes: "Operations verified the paid invoice, immutable cycle, entrant, and exact entry calculation.",
  });
  return decideAdjustmentCompliance({
    tenantId: input.tenantId,
    requestId: input.requestId,
    actorId: input.complianceId,
    disposition: input.disposition,
    notes: "Compliance approved the controlled grant and requires a replacement snapshot before selection.",
  });
}

describe.sequential("delayed paid subscription invoice incidents", () => {
  test("records a paid membership cycle but grants no entries without exact Official Rules acceptance", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 1 });
    const occurredAt = new Date();
    const membership = await createMembership({
      tenantId: tenant.id,
      campaignId: campaign.id,
      occurredAt,
      acceptRules: false,
    });
    await releasePromotionFixture(campaign.id);

    const receipt = await settleStripeSubscriptionInvoice(membership.invoice);

    expect(receipt).toMatchObject({ campaignId: campaign.id, entries: 0n, idempotent: false });
    expect(await db.payment.count({ where: { orderId: receipt.orderId, status: "CAPTURED" } })).toBe(1);
    expect(await db.subscriptionCycle.count({ where: { id: receipt.cycleId, status: "SETTLED" } })).toBe(1);
    expect(await db.entryEntitlement.count({ where: { orderId: receipt.orderId } })).toBe(0);
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: receipt.orderId } });
    expect(JSON.parse(line.entryCalculationJson)).toMatchObject({ reason: "EXACT_OFFICIAL_RULES_NOT_ACCEPTED" });
  });

  test("a stale membership rules acceptance cannot authorize entries for the current release", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 1 });
    const occurredAt = new Date();
    const membership = await createMembership({
      tenantId: tenant.id,
      campaignId: campaign.id,
      occurredAt,
      acceptRules: false,
    });
    const staleBody = "NO PURCHASE NECESSARY. Superseded membership test rules.";
    const staleRules = await db.legalDocument.create({
      data: {
        tenantId: tenant.id,
        kind: "OFFICIAL_RULES",
        slug: `superseded-rules-${randomUUID()}`,
        title: "Superseded Official Rules",
        version: 99,
        body: staleBody,
        checksum: createHash("sha256").update(staleBody).digest("hex"),
        status: "PUBLISHED",
        effectiveAt: new Date(campaign.startsAt.getTime() - 1_000),
      },
    });
    await db.rulesAcceptance.create({
      data: {
        tenantId: tenant.id,
        campaignId: campaign.id,
        entrantId: membership.entrant.id,
        legalDocumentId: staleRules.id,
        documentChecksum: staleRules.checksum,
        method: "MEMBERSHIP",
      },
    });
    await releasePromotionFixture(campaign.id);

    const receipt = await settleStripeSubscriptionInvoice(membership.invoice);

    expect(receipt).toMatchObject({ campaignId: campaign.id, entries: 0n, idempotent: false });
    expect(await db.payment.count({ where: { orderId: receipt.orderId, status: "CAPTURED" } })).toBe(1);
    expect(await db.subscriptionCycle.count({ where: { id: receipt.cycleId, status: "SETTLED" } })).toBe(1);
    expect(await db.entryEntitlement.count({ where: { orderId: receipt.orderId } })).toBe(0);
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: receipt.orderId } });
    expect(JSON.parse(line.entryCalculationJson)).toMatchObject({ reason: "EXACT_OFFICIAL_RULES_NOT_ACCEPTED" });
  });

  test("snapshot construction waits for knowable paid-invoice webhook work", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 1, closed: true });
    const operations = await createStaff(tenant.id, "OPERATIONS");
    await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, balance: 100n });
    const webhook = await db.webhookEvent.create({
      data: {
        tenantId: tenant.id,
        provider: "STRIPE",
        providerEventId: `evt_${randomUUID()}`,
        eventType: "invoice.paid",
        payloadHash: "f".repeat(64),
        status: "FAILED",
        attempts: 1,
        lastError: "Simulated delayed paid-invoice settlement",
      },
    });
    await releasePromotionFixture(campaign.id);
    await expect(buildEntrySnapshot(campaign.id, operations.id)).rejects.toThrow(/unresolved queues/i);
    expect(await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ status: "ENTRY_CLOSED" });
    await db.webhookEvent.update({ where: { id: webhook.id }, data: { status: "PROCESSED", processedAt: new Date() } });
    expect(await buildEntrySnapshot(campaign.id, operations.id)).toMatchObject({
      snapshot: { status: "AWAITING_APPROVAL", totalEntries: 100n },
    });
  });

  test("records money once after freeze, then dual approval posts the grant and rebuilds", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 1, drawReady: true });
    const operations = await createStaff(tenant.id, "OPERATIONS");
    const compliance = await createStaff(tenant.id, "COMPLIANCE");
    await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, balance: 100n });
    const occurredAt = new Date(Date.now() - 10_000);
    const membership = await createMembership({ tenantId: tenant.id, campaignId: campaign.id, occurredAt });
    const sealed = await closeAndSeal({
      campaignId: campaign.id,
      operationsId: operations.id,
      complianceId: compliance.id,
      cutoffAt: new Date(Date.now() - 5_000),
    });

    const first = await settleStripeSubscriptionInvoice(membership.invoice);
    const replay = await settleStripeSubscriptionInvoice(membership.invoice);
    expect(first).toMatchObject({ entries: 0n, campaignId: campaign.id, idempotent: false });
    expect(replay).toMatchObject({ orderId: first.orderId, cycleId: first.cycleId, idempotent: true });
    expect(await db.payment.count({ where: { orderId: first.orderId, status: "CAPTURED" } })).toBe(1);
    expect(await db.subscriptionCycle.count({ where: { orderId: first.orderId, status: "SETTLED" } })).toBe(1);
    expect(await db.entryEntitlement.count({ where: { orderId: first.orderId } })).toBe(0);
    const request = await db.entryAdjustmentRequest.findUniqueOrThrow({
      where: { subscriptionCycleId: first.cycleId },
    });
    expect(request).toMatchObject({ kind: "LATE_SUBSCRIPTION_GRANT", status: "PENDING", delta: 100n });

    await approveCase({
      tenantId: tenant.id,
      requestId: request.id,
      operationsId: operations.id,
      complianceId: compliance.id,
      disposition: "APPLY_BEFORE_DRAW",
    });
    expect(await db.entrySnapshot.findUniqueOrThrow({ where: { id: sealed.id } })).toMatchObject({ status: "VOID" });
    expect(await db.entryAdjustmentRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: "APPLIED" });
    expect((await db.entryAccount.findFirstOrThrow({
      where: { campaignId: campaign.id, entrantId: membership.entrant.id },
    })).balance).toBe(100n);
    expect((await db.order.findUniqueOrThrow({ where: { id: first.orderId } })).entryTotal).toBe(100n);
    const rebuilt = await buildEntrySnapshot(campaign.id, operations.id);
    expect(rebuilt.snapshot).toMatchObject({ version: 2, totalEntries: 200n });
  });

  test("sequential delayed invoices reserve the remaining cap once and recheck it when applied", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 1, drawReady: true, maxEntries: 100n });
    const operations = await createStaff(tenant.id, "OPERATIONS");
    const compliance = await createStaff(tenant.id, "COMPLIANCE");
    const occurredAt = new Date(Date.now() - 10_000);
    const membership = await createMembership({
      tenantId: tenant.id,
      campaignId: campaign.id,
      occurredAt,
      fixedEntries: 60n,
    });
    await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, balance: 100n });
    await closeAndSeal({
      campaignId: campaign.id,
      operationsId: operations.id,
      complianceId: compliance.id,
      cutoffAt: new Date(Date.now() - 5_000),
    });

    const first = await settleStripeSubscriptionInvoice(membership.invoice);
    const secondInvoice = nextPaidInvoice(membership.invoice, 1);
    const second = await settleStripeSubscriptionInvoice(secondInvoice);
    const third = await settleStripeSubscriptionInvoice(nextPaidInvoice(secondInvoice, 1));
    const requests = await db.entryAdjustmentRequest.findMany({
      where: { campaignId: campaign.id, entryAccountId: { not: "" }, delta: { gt: 0n } },
      orderBy: { createdAt: "asc" },
    });
    expect(requests.map((request) => request.delta)).toEqual([60n, 40n]);
    expect(requests.reduce((sum, request) => sum + request.delta, 0n)).toBe(100n);
    expect([first.entries, second.entries, third.entries]).toEqual([0n, 0n, 0n]);
    expect(await db.payment.count({
      where: { order: { campaignId: campaign.id, channel: "SUBSCRIPTION" }, status: "CAPTURED" },
    })).toBe(3);
    expect(await db.subscriptionCycle.count({
      where: { subscriptionId: membership.subscription.id, status: "SETTLED" },
    })).toBe(3);

    for (const request of requests) {
      await approveCase({
        tenantId: tenant.id,
        requestId: request.id,
        operationsId: operations.id,
        complianceId: compliance.id,
        disposition: "APPLY_BEFORE_DRAW",
      });
    }
    expect((await db.entryAccount.findUniqueOrThrow({
      where: { campaignId_entrantId: { campaignId: campaign.id, entrantId: membership.entrant.id } },
    })).balance).toBe(100n);
  });

  test("concurrent delayed invoices serialize positive reservations across subscriptions", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 1, drawReady: true, maxEntries: 100n });
    const operations = await createStaff(tenant.id, "OPERATIONS");
    const compliance = await createStaff(tenant.id, "COMPLIANCE");
    const occurredAt = new Date(Date.now() - 10_000);
    const firstMembership = await createMembership({
      tenantId: tenant.id,
      campaignId: campaign.id,
      occurredAt,
      fixedEntries: 60n,
    });
    const secondMembership = await createMembership({
      tenantId: tenant.id,
      campaignId: campaign.id,
      occurredAt: new Date(occurredAt.getTime() + 1),
      fixedEntries: 60n,
      identity: { user: firstMembership.user, entrant: firstMembership.entrant },
    });
    await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, balance: 100n });
    await db.entryAccount.create({
      data: {
        tenantId: tenant.id,
        campaignId: campaign.id,
        entrantId: firstMembership.entrant.id,
      },
    });
    await closeAndSeal({
      campaignId: campaign.id,
      operationsId: operations.id,
      complianceId: compliance.id,
      cutoffAt: new Date(Date.now() - 5_000),
    });

    const receipts = await Promise.all([
      settleStripeSubscriptionInvoice(firstMembership.invoice),
      settleStripeSubscriptionInvoice(secondMembership.invoice),
    ]);
    expect(receipts.map((receipt) => receipt.entries)).toEqual([0n, 0n]);
    const requests = await db.entryAdjustmentRequest.findMany({
      where: { campaignId: campaign.id, entryAccountId: (await db.entryAccount.findFirstOrThrow({
        where: { campaignId: campaign.id, entrantId: firstMembership.entrant.id },
      })).id },
    });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.delta).sort((a, b) => Number(a - b))).toEqual([40n, 60n]);
    expect(requests.reduce((sum, request) => sum + request.delta, 0n)).toBe(100n);
    expect(await db.payment.count({ where: { id: { in: receipts.map((receipt) => receipt.paymentId) } } })).toBe(2);
  });

  test("sealed entry-account state cannot be forged to bypass reserved-capacity review", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 1, drawReady: true, maxEntries: 100n });
    const operations = await createStaff(tenant.id, "OPERATIONS");
    const compliance = await createStaff(tenant.id, "COMPLIANCE");
    const occurredAt = new Date(Date.now() - 10_000);
    const membership = await createMembership({
      tenantId: tenant.id,
      campaignId: campaign.id,
      occurredAt,
      fixedEntries: 60n,
    });
    await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, balance: 100n });
    await closeAndSeal({
      campaignId: campaign.id,
      operationsId: operations.id,
      complianceId: compliance.id,
      cutoffAt: new Date(Date.now() - 5_000),
    });
    const receipt = await settleStripeSubscriptionInvoice(membership.invoice);
    const request = await db.entryAdjustmentRequest.findUniqueOrThrow({
      where: { subscriptionCycleId: receipt.cycleId },
    });
    await expect(db.entryAccount.update({
      where: { id: request.entryAccountId },
      data: { balance: 50n, version: { increment: 1 } },
    })).rejects.toThrow();
    expect(await db.entryAdjustmentRequest.findUniqueOrThrow({ where: { id: request.id } }))
      .toMatchObject({ status: "PENDING", delta: 60n });
  });

  test("an explicit post-draw void preserves historical records and rebuilds", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 1, drawReady: true });
    const operations = await createStaff(tenant.id, "OPERATIONS");
    const compliance = await createStaff(tenant.id, "COMPLIANCE");
    await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, balance: 100n });
    const occurredAt = new Date(Date.now() - 10_000);
    const membership = await createMembership({ tenantId: tenant.id, campaignId: campaign.id, occurredAt });
    const sealed = await closeAndSeal({
      campaignId: campaign.id,
      operationsId: operations.id,
      complianceId: compliance.id,
      cutoffAt: new Date(Date.now() - 5_000),
    });
    const draw = await conductDemoDraw(sealed.id, operations.id, 1);
    const receipt = await settleStripeSubscriptionInvoice(membership.invoice);
    const request = await db.entryAdjustmentRequest.findUniqueOrThrow({ where: { subscriptionCycleId: receipt.cycleId } });
    await approveCase({
      tenantId: tenant.id,
      requestId: request.id,
      operationsId: operations.id,
      complianceId: compliance.id,
      disposition: "VOID_DRAW_AND_REBUILD",
    });
    expect(await db.draw.findUniqueOrThrow({ where: { id: draw.id } })).toMatchObject({ status: "VOID" });
    expect(await db.entrySnapshot.findUniqueOrThrow({ where: { id: sealed.id } })).toMatchObject({ status: "VOID" });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ status: "RECONCILING" });
    expect(await db.draw.count({ where: { id: draw.id } })).toBe(1);
  });

  test("a published winner leaves the late grant unresolved and blocks fulfillment", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 1, drawReady: true });
    await db.campaignPrize.create({
      data: {
        tenantId: tenant.id,
        campaignId: campaign.id,
        name: "Delayed invoice test prize",
        description: "Disposable integration prize",
        approximateValueCents: 100_000,
        currency: "USD",
      },
    });
    const operations = await createStaff(tenant.id, "OPERATIONS");
    const compliance = await createStaff(tenant.id, "COMPLIANCE");
    const administrator = await createStaff(tenant.id, "ADMIN");
    await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, balance: 100n });
    const occurredAt = new Date(Date.now() - 10_000);
    const membership = await createMembership({ tenantId: tenant.id, campaignId: campaign.id, occurredAt });
    const sealed = await closeAndSeal({
      campaignId: campaign.id,
      operationsId: operations.id,
      complianceId: compliance.id,
      cutoffAt: new Date(Date.now() - 5_000),
    });
    const draw = await conductDemoDraw(sealed.id, operations.id, 1);
    const candidate = draw.candidates[0]!;
    await recordCandidateContact({
      tenantId: tenant.id,
      candidateId: candidate.id,
      actorId: operations.id,
      contactDeadline: new Date(Date.now() + 7 * 86_400_000),
    });
    const verified = await decideDrawCandidate({
      tenantId: tenant.id,
      candidateId: candidate.id,
      actorId: compliance.id,
      decision: "VERIFY",
      reason: "Identity, age, residence, and official-rules eligibility were verified.",
    });
    await publishVerifiedWinner({
      tenantId: tenant.id,
      winnerId: verified.winner!.id,
      actorId: administrator.id,
      publicName: "Published Test Winner",
      publicLocation: "Denver, CO",
      publicationConsentConfirmed: true,
    });
    const receipt = await settleStripeSubscriptionInvoice(membership.invoice);
    const request = await db.entryAdjustmentRequest.findUniqueOrThrow({ where: { subscriptionCycleId: receipt.cycleId } });
    await expect(recordWinnerFulfillment({
      tenantId: tenant.id,
      winnerId: verified.winner!.id,
      actorId: operations.id,
      evidenceReference: "fulfillment-evidence://blocked",
    })).rejects.toThrow(/adjustment incidents/i);
    await approveAdjustmentEvidence({
      tenantId: tenant.id,
      requestId: request.id,
      actorId: operations.id,
      evidenceRef: `stripe-evidence://${randomUUID()}`,
      notes: "Operations verified the immutable paid invoice and calculated late grant.",
    });
    await expect(decideAdjustmentCompliance({
      tenantId: tenant.id,
      requestId: request.id,
      actorId: compliance.id,
      disposition: "VOID_DRAW_AND_REBUILD",
      notes: "Compliance attempted a rebuild but publication requires an external remedy.",
    })).rejects.toThrow(/external-remedy incident/i);
    expect(await db.entryAdjustmentRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: "REVIEW" });
    expect(await db.entryEntitlement.count({ where: { orderId: receipt.orderId } })).toBe(0);
  });

  test("a post-publication refund revokes the unfulfilled winner and advances the alternate", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 1, drawReady: true });
    await db.campaignPrize.create({
      data: {
        tenantId: tenant.id,
        campaignId: campaign.id,
        name: "Winner revocation test prize",
        description: "Disposable integration prize",
        approximateValueCents: 100_000,
        currency: "USD",
      },
    });
    const operations = await createStaff(tenant.id, "OPERATIONS");
    const compliance = await createStaff(tenant.id, "COMPLIANCE");
    const administrator = await createStaff(tenant.id, "ADMIN");
    const product = await createProduct({ tenantId: tenant.id, priceCents: 10_000 });
    const orders = [];
    for (const email of ["winner-one@example.test", "winner-two@example.test"]) {
      const checkout = await completeDemoCheckout(checkoutInput({
        email,
        lines: [{ productId: product.id, variantId: product.variants[0]!.id, quantity: 1 }],
      }), tenant.slug);
      orders.push(await db.order.findFirstOrThrow({
        where: { tenantId: tenant.id, orderNumber: checkout.orderNumber },
      }));
    }
    const sealed = await closeAndSeal({
      campaignId: campaign.id,
      operationsId: operations.id,
      complianceId: compliance.id,
      cutoffAt: new Date(Date.now() - 1_000),
    });
    const draw = await conductDemoDraw(sealed.id, operations.id, 2);
    const candidate = draw.candidates[0]!;
    const account = await db.entryAccount.findUniqueOrThrow({ where: { id: candidate.entryAccountId } });
    const selectedOrder = orders.find((order) => order.entrantId === account.entrantId)!;
    await recordCandidateContact({
      tenantId: tenant.id,
      candidateId: candidate.id,
      actorId: operations.id,
      contactDeadline: new Date(Date.now() + 7 * 86_400_000),
    });
    const verified = await decideDrawCandidate({
      tenantId: tenant.id,
      candidateId: candidate.id,
      actorId: compliance.id,
      decision: "VERIFY",
      reason: "Identity, age, residence, and official-rules eligibility were verified.",
    });
    await publishVerifiedWinner({
      tenantId: tenant.id,
      winnerId: verified.winner!.id,
      actorId: administrator.id,
      publicName: "Refunded Test Winner",
      publicLocation: "Denver, CO",
      publicationConsentConfirmed: true,
    });
    const refund = await settleDemoRefund({
      orderId: selectedOrder.id,
      amountCents: 1_000,
      reason: "A provider-confirmed refund triggered the published winner rules review.",
      actorId: operations.id,
      idempotencyKey: `published-refund:${randomUUID()}`,
    });
    const request = await db.entryAdjustmentRequest.findUniqueOrThrow({ where: { refundId: refund.id } });
    await approveAdjustmentEvidence({
      tenantId: tenant.id,
      requestId: request.id,
      actorId: operations.id,
      evidenceRef: `refund-evidence://${randomUUID()}`,
      notes: "Operations verified the provider refund and relationship to the published winner.",
    });
    await decideAdjustmentCompliance({
      tenantId: tenant.id,
      requestId: request.id,
      actorId: compliance.id,
      disposition: "DISQUALIFY_ENTRANT",
      notes: "The official rules require revocation and alternate advancement after this refund.",
    });
    expect(await db.winner.findUniqueOrThrow({ where: { id: verified.winner!.id } })).toMatchObject({ status: "REVOKED" });
    expect(await db.drawCandidate.findUniqueOrThrow({ where: { id: candidate.id } })).toMatchObject({ status: "DISQUALIFIED" });
    expect(await db.drawCandidate.findFirstOrThrow({ where: { drawId: draw.id, rank: 2 } })).toMatchObject({ status: "CONTACTING" });
    expect(await db.draw.findUniqueOrThrow({ where: { id: draw.id } })).toMatchObject({ status: "VERIFYING" });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ status: "WINNER_PENDING" });
  });

  test("a fulfilled winner keeps a later refund case unresolved for external remedy", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 1, drawReady: true });
    await db.campaignPrize.create({
      data: {
        tenantId: tenant.id,
        campaignId: campaign.id,
        name: "Fulfilled winner incident prize",
        description: "Disposable integration prize",
        approximateValueCents: 100_000,
        currency: "USD",
      },
    });
    const operations = await createStaff(tenant.id, "OPERATIONS");
    const compliance = await createStaff(tenant.id, "COMPLIANCE");
    const administrator = await createStaff(tenant.id, "ADMIN");
    const product = await createProduct({ tenantId: tenant.id, priceCents: 10_000 });
    const checkout = await completeDemoCheckout(checkoutInput({
      email: "fulfilled-winner@example.test",
      lines: [{ productId: product.id, variantId: product.variants[0]!.id, quantity: 1 }],
    }), tenant.slug);
    const order = await db.order.findFirstOrThrow({
      where: { tenantId: tenant.id, orderNumber: checkout.orderNumber },
    });
    const sealed = await closeAndSeal({
      campaignId: campaign.id,
      operationsId: operations.id,
      complianceId: compliance.id,
      cutoffAt: new Date(Date.now() - 1_000),
    });
    const draw = await conductDemoDraw(sealed.id, operations.id, 1);
    const candidate = draw.candidates[0]!;
    await recordCandidateContact({
      tenantId: tenant.id,
      candidateId: candidate.id,
      actorId: operations.id,
      contactDeadline: new Date(Date.now() + 7 * 86_400_000),
    });
    const verified = await decideDrawCandidate({
      tenantId: tenant.id,
      candidateId: candidate.id,
      actorId: compliance.id,
      decision: "VERIFY",
      reason: "Identity, age, residence, and official-rules eligibility were verified.",
    });
    await publishVerifiedWinner({
      tenantId: tenant.id,
      winnerId: verified.winner!.id,
      actorId: administrator.id,
      publicName: "Fulfilled Test Winner",
      publicLocation: "Denver, CO",
      publicationConsentConfirmed: true,
    });
    await recordWinnerFulfillment({
      tenantId: tenant.id,
      winnerId: verified.winner!.id,
      actorId: operations.id,
      evidenceReference: "fulfillment-evidence://completed-before-refund",
    });
    const refund = await settleDemoRefund({
      orderId: order.id,
      amountCents: 1_000,
      reason: "A provider-confirmed refund arrived after documented prize fulfillment.",
      actorId: operations.id,
      idempotencyKey: `fulfilled-refund:${randomUUID()}`,
    });
    const request = await db.entryAdjustmentRequest.findUniqueOrThrow({ where: { refundId: refund.id } });
    await approveAdjustmentEvidence({
      tenantId: tenant.id,
      requestId: request.id,
      actorId: operations.id,
      evidenceRef: `refund-evidence://${randomUUID()}`,
      notes: "Operations verified the refund occurred after documented winner fulfillment.",
    });
    await expect(decideAdjustmentCompliance({
      tenantId: tenant.id,
      requestId: request.id,
      actorId: compliance.id,
      disposition: "DISQUALIFY_ENTRANT",
      notes: "Compliance cannot retroactively revoke fulfilled prize delivery without external remedy.",
    })).rejects.toThrow(/external-remedy incident/i);
    expect(await db.entryAdjustmentRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: "REVIEW" });
    expect(await db.winner.findUniqueOrThrow({ where: { id: verified.winner!.id } })).toMatchObject({
      status: "PUBLISHED",
      fulfilledAt: expect.any(Date),
    });
  });
});
