import { randomUUID } from "node:crypto";
import { compare, hash } from "bcryptjs";
import { afterEach, describe, expect, test } from "vitest";
import { db } from "@/server/db";
import {
  consumeEmailVerificationChallenge,
  consumePasswordResetChallenge,
  issueAccountChallenge,
  reconstructAccountChallengeToken,
} from "@/server/auth/challenges";
import { hashIdentifier } from "@/server/auth/crypto";
import { completeDemoCheckout } from "@/server/commerce/checkout";
import { submitFreeEntry } from "@/server/entries/free-entry";
import { buildTransactionalEmail } from "@/server/notifications/templates";
import {
  checkoutInput,
  createEntrantAccount,
  createProduct,
  createPromotion,
  freeEntryInput,
} from "./fixtures";

afterEach(async () => {
  // Avoid leaving consumed challenge emails in the shared integration outbox;
  // the notification suite separately verifies all deliverable email kinds.
  await db.outboxEvent.deleteMany({
    where: { kind: { in: ["ACCOUNT_EMAIL_VERIFICATION", "ACCOUNT_PASSWORD_RECOVERY"] } },
  });
});

describe.sequential("tenant-scoped account proofs and guest history claim", () => {
  test("concurrent recovery requests leave at most one usable latest challenge", async () => {
    const { tenant } = await createPromotion();
    const normalizedEmail = `concurrent-reset-${randomUUID()}@example.test`;
    const user = await db.user.create({
      data: {
        tenantId: tenant.id,
        email: normalizedEmail,
        normalizedEmail,
        name: "Concurrent Recovery Owner",
        passwordHash: await hash("OriginalPassword!234", 4),
        emailVerifiedAt: new Date(),
      },
    });
    const attempts = await Promise.allSettled([
      issueAccountChallenge({ tenantId: tenant.id, userId: user.id, purpose: "RESET_PASSWORD" }),
      issueAccountChallenge({ tenantId: tenant.id, userId: user.id, purpose: "RESET_PASSWORD" }),
    ]);
    expect(attempts.some((attempt) => attempt.status === "fulfilled")).toBe(true);
    const active = await db.accountChallenge.findMany({
      where: { tenantId: tenant.id, userId: user.id, purpose: "RESET_PASSWORD", consumedAt: null },
    });
    expect(active).toHaveLength(1);
    expect(reconstructAccountChallengeToken(active[0]!)).toBeTruthy();
  });

  test("email verification safely claims one canonical populated guest entrant", async () => {
    const { tenant, campaign } = await createPromotion();
    const otherTenant = (await createPromotion()).tenant;
    const normalizedEmail = `claim-${randomUUID()}@example.test`;
    const guest = await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, email: normalizedEmail, balance: 75n });
    await db.order.create({
      data: {
        tenantId: tenant.id,
        campaignId: campaign.id,
        entrantId: guest.entrant.id,
        orderNumber: `CLAIM-${randomUUID()}`,
        status: "CONFIRMED",
        paymentStatus: "CAPTURED",
        email: normalizedEmail,
        customerName: "Guest History",
        currency: "USD",
        subtotalCents: 100,
        totalCents: 100,
        shippingAddressJson: "{}",
        provider: "DEMO",
        idempotencyKey: randomUUID(),
      },
    });
    const user = await db.user.create({
      data: {
        tenantId: tenant.id,
        email: normalizedEmail,
        normalizedEmail,
        name: "Verified Owner",
        passwordHash: await hash("OriginalPassword!234", 4),
      },
    });
    const emptyDuplicate = await db.entrant.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        normalizedEmail,
        emailHash: hashIdentifier(normalizedEmail),
        name: user.name,
      },
    });
    await issueAccountChallenge({ tenantId: tenant.id, userId: user.id, purpose: "VERIFY_EMAIL" });
    const challenge = await db.accountChallenge.findFirstOrThrow({
      where: { tenantId: tenant.id, userId: user.id, purpose: "VERIFY_EMAIL" },
      orderBy: { createdAt: "desc" },
    });
    const token = reconstructAccountChallengeToken(challenge);
    const outbox = await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: challenge.id } });
    expect(outbox.payloadJson).toBe("{}");
    expect(challenge.tokenDigest).not.toContain(token);
    const email = await buildTransactionalEmail(outbox);
    expect(email?.text).toContain(encodeURIComponent(token));

    await expect(consumeEmailVerificationChallenge({ tenantId: otherTenant.id, token })).resolves.toBe("INVALID");
    await expect(consumeEmailVerificationChallenge({ tenantId: tenant.id, token })).resolves.toBe("VERIFIED");
    await expect(consumeEmailVerificationChallenge({ tenantId: tenant.id, token })).resolves.toBe("INVALID");

    expect(await db.entrant.findUnique({ where: { id: emptyDuplicate.id } })).toBeNull();
    expect(await db.entrant.findUniqueOrThrow({ where: { id: guest.entrant.id } })).toMatchObject({ userId: user.id });
    expect(await db.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ emailVerifiedAt: expect.any(Date) });
    expect(await db.order.findFirstOrThrow({ where: { entrantId: guest.entrant.id } })).toMatchObject({ userId: user.id });
    expect(await db.auditEvent.count({ where: { tenantId: tenant.id, action: "EMAIL_VERIFIED_AND_HISTORY_CLAIMED" } })).toBe(1);
  });

  test("verification fails closed when two populated histories share the address", async () => {
    const { tenant, campaign } = await createPromotion();
    const normalizedEmail = `conflict-${randomUUID()}@example.test`;
    const first = await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, email: normalizedEmail, balance: 1n });
    const second = await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, email: normalizedEmail, balance: 2n });
    const user = await db.user.create({
      data: {
        tenantId: tenant.id,
        email: normalizedEmail,
        normalizedEmail,
        name: "Conflicted Owner",
        passwordHash: await hash("OriginalPassword!234", 4),
        entrant: {
          create: {
            tenantId: tenant.id,
            normalizedEmail,
            emailHash: hashIdentifier(normalizedEmail),
            name: "Conflicted Owner",
          },
        },
      },
    });
    await issueAccountChallenge({ tenantId: tenant.id, userId: user.id, purpose: "VERIFY_EMAIL" });
    const challenge = await db.accountChallenge.findFirstOrThrow({ where: { userId: user.id } });
    const result = await consumeEmailVerificationChallenge({
      tenantId: tenant.id,
      token: reconstructAccountChallengeToken(challenge),
    });
    expect(result).toBe("REVIEW_REQUIRED");
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).toEqual(expect.any(Date));
    expect((await db.entrant.findUniqueOrThrow({ where: { id: first.entrant.id } })).userId).toBeNull();
    expect((await db.entrant.findUniqueOrThrow({ where: { id: second.entrant.id } })).userId).toBeNull();
    expect(await db.supportTicket.count({ where: { tenantId: tenant.id, userId: user.id, status: "OPEN" } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: tenant.id, action: "ACCOUNT_HISTORY_CLAIM_REVIEW_REQUIRED" } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: tenant.id, action: "EMAIL_VERIFIED_HISTORY_UNMERGED" } })).toBe(1);
  });

  test("password recovery is single-use, expires, is tenant-bound, and revokes every session", async () => {
    const { tenant } = await createPromotion();
    const otherTenant = (await createPromotion()).tenant;
    const normalizedEmail = `reset-${randomUUID()}@example.test`;
    const user = await db.user.create({
      data: {
        tenantId: tenant.id,
        email: normalizedEmail,
        normalizedEmail,
        name: "Recovery Owner",
        passwordHash: await hash("OriginalPassword!234", 4),
        emailVerifiedAt: new Date(),
      },
    });
    await db.session.createMany({
      data: [1, 2].map((index) => ({
        tenantId: tenant.id,
        userId: user.id,
        tokenHash: `recovery-session-${index}-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      })),
    });
    await issueAccountChallenge({ tenantId: tenant.id, userId: user.id, purpose: "RESET_PASSWORD" });
    const superseded = await db.accountChallenge.findFirstOrThrow({
      where: { userId: user.id, purpose: "RESET_PASSWORD" },
      orderBy: { createdAt: "desc" },
    });
    const supersededToken = reconstructAccountChallengeToken(superseded);
    await issueAccountChallenge({ tenantId: tenant.id, userId: user.id, purpose: "RESET_PASSWORD" });
    const challenge = await db.accountChallenge.findFirstOrThrow({
      where: { userId: user.id, purpose: "RESET_PASSWORD", consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    const token = reconstructAccountChallengeToken(challenge);
    const newHash = await hash("ReplacementPassword!789", 4);
    await expect(consumePasswordResetChallenge({
      tenantId: tenant.id,
      token: supersededToken,
      passwordHash: newHash,
    })).resolves.toBe("INVALID");
    await expect(consumePasswordResetChallenge({ tenantId: otherTenant.id, token, passwordHash: newHash })).resolves.toBe("INVALID");
    await expect(consumePasswordResetChallenge({ tenantId: tenant.id, token, passwordHash: newHash })).resolves.toBe("RESET");
    await expect(consumePasswordResetChallenge({ tenantId: tenant.id, token, passwordHash: newHash })).resolves.toBe("INVALID");
    const updated = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await compare("ReplacementPassword!789", updated.passwordHash)).toBe(true);
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);

    const oldNow = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    await issueAccountChallenge({ tenantId: tenant.id, userId: user.id, purpose: "RESET_PASSWORD", now: oldNow });
    const expired = await db.accountChallenge.findFirstOrThrow({
      where: { userId: user.id, purpose: "RESET_PASSWORD", expiresAt: { lt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    await expect(consumePasswordResetChallenge({
      tenantId: tenant.id,
      token: reconstructAccountChallengeToken(expired),
      passwordHash: newHash,
    })).resolves.toBe("INVALID");
  });

  test("verified viewer identity wins over ambiguous same-email entrant lookup", async () => {
    const { tenant, campaign } = await createPromotion();
    const product = await createProduct({ tenantId: tenant.id, priceCents: 2_500 });
    const normalizedEmail = `viewer-${randomUUID()}@example.test`;
    await db.entrant.create({
      data: {
        tenantId: tenant.id,
        normalizedEmail,
        emailHash: hashIdentifier(normalizedEmail),
        name: "Earlier Guest",
      },
    });
    const user = await db.user.create({
      data: {
        tenantId: tenant.id,
        email: normalizedEmail,
        normalizedEmail,
        name: "Verified Viewer",
        passwordHash: "not-used",
        emailVerifiedAt: new Date(),
        entrant: {
          create: {
            tenantId: tenant.id,
            normalizedEmail,
            emailHash: hashIdentifier(normalizedEmail),
            name: "Verified Viewer",
          },
        },
      },
      include: { entrant: true },
    });
    const identity = {
      tenantId: tenant.id,
      userId: user.id,
      entrantId: user.entrant!.id,
      normalizedEmail,
    };
    await completeDemoCheckout(checkoutInput({
      email: normalizedEmail,
      lines: [{ productId: product.id, variantId: product.variants[0]!.id, quantity: 1 }],
    }), tenant.slug, identity);
    await submitFreeEntry(freeEntryInput(campaign.slug, normalizedEmail), tenant.id, identity);
    expect(await db.order.count({ where: { tenantId: tenant.id, entrantId: identity.entrantId, userId: user.id } })).toBe(1);
    expect(await db.freeEntrySubmission.count({ where: { tenantId: tenant.id, entrantId: identity.entrantId } })).toBe(1);
  });

  test("a retried scheduled-cancellation notice renders terminal current state", async () => {
    const { tenant } = await createPromotion();
    const product = await createProduct({ tenantId: tenant.id, productType: "MEMBERSHIP" });
    const plan = await db.subscriptionPlan.create({
      data: { tenantId: tenant.id, productId: product.id, name: "Test membership", priceCents: 2_500 },
    });
    const email = `cancel-${randomUUID()}@example.test`;
    const entrant = await db.entrant.create({
      data: { tenantId: tenant.id, normalizedEmail: email, emailHash: hashIdentifier(email), name: "Cancelled Member" },
    });
    const ended = new Date(Date.now() - 1_000);
    const subscription = await db.subscription.create({
      data: {
        tenantId: tenant.id,
        planId: plan.id,
        entrantId: entrant.id,
        status: "CANCELLED",
        continuousSince: new Date(Date.now() - 86_400_000),
        currentPeriodStartsAt: new Date(Date.now() - 86_400_000),
        currentPeriodEndsAt: ended,
        cancelledAt: ended,
      },
    });
    const rendered = await buildTransactionalEmail({
      id: randomUUID(),
      tenantId: tenant.id,
      aggregateType: "Subscription",
      aggregateId: subscription.id,
      kind: "SUBSCRIPTION_CANCELLATION_SCHEDULED",
    });
    expect(rendered?.text).toContain("Your membership is cancelled");
    expect(rendered?.text).not.toContain("Cancellation is scheduled");
    await db.subscription.update({
      where: { id: subscription.id },
      data: { status: "ACTIVE", cancelAtPeriodEnd: false, cancelledAt: null },
    });
    await expect(buildTransactionalEmail({
      id: randomUUID(),
      tenantId: tenant.id,
      aggregateType: "Subscription",
      aggregateId: subscription.id,
      kind: "SUBSCRIPTION_CANCELLATION_SCHEDULED",
    })).resolves.toBeNull();
  });
});
