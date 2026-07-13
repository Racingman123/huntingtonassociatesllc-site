import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { completeDemoCheckout, loadAuthoritativeCheckoutQuote } from "@/server/commerce/checkout";
import {
  cancelStripeCheckout,
  getCheckoutReceipt,
  releaseExpiredStripeCheckoutOrders,
  settleStripeCheckoutCapture,
  startStripeCheckout,
} from "@/server/commerce/stripe-checkout";
import { approveEntrySnapshot, buildEntrySnapshot, conductDemoDraw } from "@/server/draws/operations";
import { submitFreeEntry } from "@/server/entries/free-entry";
import { reviewFreeEntry } from "@/server/entries/review";
import { db } from "@/server/db";
import { runMaintenance } from "@/server/maintenance/service";
import {
  decideDrawCandidate,
  publishVerifiedWinner,
  recordCandidateContact,
  recordWinnerFulfillment,
} from "@/server/winners/service";
import { NotificationDeliveryError, type EmailNotificationProvider } from "@/server/notifications/email";
import { EMAIL_OUTBOX_KINDS } from "@/server/notifications/templates";
import { processEmailOutboxBatch } from "@/server/notifications/worker";
import { settleDemoRefund } from "@/server/refunds/service";
import { consumeRateLimits, publicRateLimitRules } from "@/server/security/rate-limit";
import type { PreparedStripeCheckoutRequest } from "@/server/providers/stripe/checkout-contract";
import type { PreparedStripeSubscriptionRequest } from "@/server/providers/stripe/subscription-contract";
import {
  cancelSubscriptionAtPeriodEnd,
  createDemoSubscription,
  finalizeSubscriptionCancellation,
  settleDemoSubscriptionRenewal,
} from "@/server/subscriptions/service";
import {
  applyStripeSubscriptionState,
  bindStripeSubscriptionEnrollment,
  createStripeBillingPortal,
  failStripeSubscriptionInvoice,
  settleStripeSubscriptionInvoice,
  startStripeSubscriptionCheckout,
} from "@/server/subscriptions/stripe-service";
import {
  checkoutInput,
  createEntrantAccount,
  createProduct,
  createPromotion,
  createStaff,
  freeEntryInput,
  releasePromotionFixture,
} from "./fixtures";

afterAll(async () => {
  await db.$disconnect();
});

function sum(values: bigint[]) {
  return values.reduce((total, value) => total + value, 0n);
}

describe.sequential("critical promotion flows on a disposable database", () => {
  test("checkout posts one immutable monetary and entry record and replays idempotently", async () => {
    const { tenant } = await createPromotion({ multiplier: 10 });
    const product = await createProduct({
      tenantId: tenant.id,
      priceCents: 12_345,
      entryMultiplier: 2,
      productType: "PHYSICAL",
      inventory: 10,
    });
    const idempotencyKey = randomUUID();
    const input = checkoutInput({
      email: "checkout@example.test",
      idempotencyKey,
      lines: [{ productId: product.id, variantId: product.variants[0].id, quantity: 2 }],
    });

    const first = await completeDemoCheckout(input, tenant.slug);
    const replay = await completeDemoCheckout(input, tenant.slug);

    expect(first.entries).toBe(4_920n);
    expect(replay).toEqual(first);
    const order = await db.order.findUniqueOrThrow({
      where: { tenantId_idempotencyKey: { tenantId: tenant.id, idempotencyKey } },
      include: {
        lines: { include: { entitlements: { include: { ledgerEvents: true } } } },
        payments: true,
      },
    });
    expect(order).toMatchObject({
      paymentStatus: "CAPTURED",
      subtotalCents: 24_690,
      shippingCents: 0,
      totalCents: 24_690,
      entryTotal: 4_920n,
    });
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0]).toMatchObject({ quantity: 2, unitPriceCents: 12_345, qualifyingCents: 24_690, entries: 4_920n });
    expect(order.lines[0].entitlements).toHaveLength(1);
    expect(order.lines[0].entitlements[0].ledgerEvents).toHaveLength(1);
    expect(order.payments).toHaveLength(1);
    expect(await db.order.count({ where: { tenantId: tenant.id } })).toBe(1);
    expect(await db.rulesAcceptance.count({ where: { tenantId: tenant.id, method: "CHECKOUT" } })).toBe(1);
    expect(await db.outboxEvent.count({ where: { tenantId: tenant.id } })).toBe(2);
    expect((await db.productVariant.findUniqueOrThrow({ where: { id: product.variants[0].id } })).inventory).toBe(8);
    const account = await db.entryAccount.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const ledger = await db.entryLedgerEvent.findMany({ where: { entryAccountId: account.id } });
    expect(account.balance).toBe(sum(ledger.map((event) => event.delta)));
  });

  test("checkout rejects ambiguous overlapping active campaigns", async () => {
    const { tenant, rules } = await createPromotion();
    const product = await createProduct({ tenantId: tenant.id });
    const now = Date.now();
    const suffix = randomUUID();
    await db.campaign.create({
      data: {
        tenantId: tenant.id,
        slug: `overlap-${suffix}`,
        code: `OVERLAP-${suffix}`,
        title: "Overlapping integration campaign",
        shortDescription: "Must not be selected implicitly.",
        longDescription: "The cart has no campaign identity, so checkout must fail closed.",
        status: "LIVE",
        startsAt: new Date(now - 60 * 60 * 1000),
        endsAt: new Date(now + 24 * 60 * 60 * 1000),
        freeEntryEndsAt: new Date(now + 24 * 60 * 60 * 1000),
        drawAt: new Date(now + 48 * 60 * 60 * 1000),
        currentMultiplier: 25,
        eligibilitySummary: "Integration test eligibility.",
        rulesVersion: rules.version,
        officialRulesDocumentId: rules.id,
        officialRulesChecksum: rules.checksum,
        configChecksum: createHash("sha256").update(suffix).digest("hex"),
        approvedAt: new Date(now - 60 * 60 * 1000),
      },
    });

    await expect(loadAuthoritativeCheckoutQuote(checkoutInput({
      email: "ambiguous-campaign@example.test",
      lines: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1 }],
    }), tenant.slug)).rejects.toThrow(/multiple active promotions.*explicit campaign/i);
  });

  test("prepared Stripe checkout grants only after canonical capture and releases failed reservations", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 10 });
    await db.entryMultiplierPeriod.create({
      data: {
        campaignId: campaign.id,
        label: "Scheduled integration 20X",
        numerator: 20,
        denominator: 1,
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const product = await createProduct({
      tenantId: tenant.id,
      priceCents: 10_000,
      productType: "PHYSICAL",
      inventory: 10,
    });
    let preparedRequest: PreparedStripeCheckoutRequest | null = null;
    const providerCheckoutId = `cs_test_${randomUUID()}`;
    const input = checkoutInput({
      email: "stripe-checkout@example.test",
      lines: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1 }],
    });
    const started = await startStripeCheckout(input, tenant.slug, {
      async createForPreparedOrder(request) {
        preparedRequest = request;
        return {
          providerCheckoutId,
          redirectUrl: "https://checkout.stripe.test/session",
        };
      },
    });
    expect(started.redirectUrl).toBe("https://checkout.stripe.test/session");
    expect(preparedRequest).toMatchObject({
      tenantId: tenant.id,
      expectedAmountCents: 11_200,
      currency: "USD",
      shippingCents: 1_200,
      lines: [{ unitPriceCents: 10_000, quantity: 1 }],
    });
    const pending = await db.order.findUniqueOrThrow({
      where: { providerCheckoutId },
      include: { payments: true, lines: { include: { entitlements: true } } },
    });
    expect(pending).toMatchObject({
      status: "PENDING",
      paymentStatus: "UNPAID",
      provider: "STRIPE",
      inventoryReservationStatus: "HELD",
    });
    expect(pending.orderNumber).toMatch(/^ORD-/);
    expect(pending.payments).toHaveLength(0);
    expect(pending.lines[0].entitlements).toHaveLength(0);
    expect(JSON.parse(pending.lines[0].entryCalculationJson)).toMatchObject({
      campaignMultiplier: 20,
      multiplierResolution: {
        source: "SCHEDULED_PERIOD",
        factor: 20,
      },
    });
    expect((await db.productVariant.findUniqueOrThrow({ where: { id: product.variants[0].id } })))
      .toMatchObject({ inventory: 10, reservedInventory: 1 });

    const captureInput = {
      tenantId: tenant.id,
      orderId: pending.id,
      providerCheckoutId,
      providerPaymentId: `pi_test_${randomUUID()}`,
      providerEventId: `checkout:${providerCheckoutId}`,
      orderFingerprint: pending.checkoutFingerprint!,
      capturedAmountCents: pending.totalCents,
      currency: pending.currency,
      occurredAt: new Date(),
      payloadHash: "d".repeat(64),
      idempotencyKey: `stripe-checkout-capture:${providerCheckoutId}`,
    };
    const captured = await settleStripeCheckoutCapture(captureInput);
    const replay = await settleStripeCheckoutCapture(captureInput);
    expect(captured).toMatchObject({ orderId: pending.id, entries: 2_000n, idempotent: false });
    expect(replay).toMatchObject({ orderId: pending.id, entries: 2_000n, idempotent: true });
    const confirmed = await db.order.findUniqueOrThrow({
      where: { id: pending.id },
      include: { payments: true, lines: { include: { entitlements: { include: { ledgerEvents: true } } } } },
    });
    expect(confirmed).toMatchObject({
      status: "CONFIRMED",
      paymentStatus: "CAPTURED",
      entryTotal: 2_000n,
      inventoryReservationStatus: "COMMITTED",
    });
    expect(confirmed.payments).toHaveLength(1);
    expect(confirmed.lines[0].entitlements).toHaveLength(1);
    expect(confirmed.lines[0].entitlements[0].ledgerEvents).toHaveLength(1);
    expect((await db.productVariant.findUniqueOrThrow({ where: { id: product.variants[0].id } })))
      .toMatchObject({ inventory: 9, reservedInventory: 0 });
    expect(await db.inventoryAdjustment.count({ where: { orderId: pending.id } })).toBe(1);
    expect(await getCheckoutReceipt(started.receipt, tenant.id)).toMatchObject({ orderNumber: pending.orderNumber });
    expect(await getCheckoutReceipt(started.receipt, "another-tenant")).toBeNull();

    const cancelledProduct = await createProduct({
      tenantId: tenant.id,
      priceCents: 5_000,
      productType: "PHYSICAL",
      inventory: 4,
    });
    const cancelledSessionId = `cs_cancel_${randomUUID()}`;
    const cancellationStart = await startStripeCheckout(checkoutInput({
      email: "stripe-expiry@example.test",
      lines: [{
        productId: cancelledProduct.id,
        variantId: cancelledProduct.variants[0].id,
        quantity: 2,
      }],
    }), tenant.slug, {
      async createForPreparedOrder() {
        return {
          providerCheckoutId: cancelledSessionId,
          redirectUrl: "https://checkout.stripe.test/expiring-session",
        };
      },
    });
    const cancellableOrder = await db.order.findUniqueOrThrow({
      where: { providerCheckoutId: cancelledSessionId },
    });
    expect((await db.productVariant.findUniqueOrThrow({ where: { id: cancelledProduct.variants[0].id } })))
      .toMatchObject({ inventory: 4, reservedInventory: 2 });
    const cancellation = await cancelStripeCheckout({
      tenantId: tenant.id,
      orderId: cancellableOrder.id,
      providerCheckoutId: cancelledSessionId,
      orderFingerprint: cancellableOrder.checkoutFingerprint!,
      occurredAt: new Date(),
      reason: "SESSION_EXPIRED",
      idempotencyKey: `stripe-checkout-cancel:${cancelledSessionId}:SESSION_EXPIRED`,
    });
    expect(cancellation).toMatchObject({ status: "CANCELLED", idempotent: false });
    expect(await getCheckoutReceipt(cancellationStart.receipt, tenant.id)).toMatchObject({ status: "CANCELLED" });
    expect((await db.productVariant.findUniqueOrThrow({ where: { id: cancelledProduct.variants[0].id } })))
      .toMatchObject({ inventory: 4, reservedInventory: 0 });
    expect(await db.payment.count({ where: { orderId: cancellableOrder.id } })).toBe(0);
    expect(await db.entryEntitlement.count({ where: { orderId: cancellableOrder.id } })).toBe(0);
  });

  test("captures delayed Stripe money but withholds entries after entrant disqualification", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 10 });
    const product = await createProduct({
      tenantId: tenant.id,
      priceCents: 4_000,
      productType: "PHYSICAL",
      inventory: 3,
    });
    const providerCheckoutId = `cs_disqualified_${randomUUID()}`;
    await startStripeCheckout(checkoutInput({
      email: "disqualified-before-capture@example.test",
      lines: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1 }],
    }), tenant.slug, {
      async createForPreparedOrder() {
        return {
          providerCheckoutId,
          redirectUrl: "https://checkout.stripe.test/disqualified",
        };
      },
    });
    const pending = await db.order.findUniqueOrThrow({
      where: { providerCheckoutId },
      include: { lines: true },
    });
    expect(pending.lines[0]!.entries).toBeGreaterThan(0n);
    await db.campaignEntrant.update({
      where: {
        campaignId_entrantId: {
          campaignId: campaign.id,
          entrantId: pending.entrantId,
        },
      },
      data: {
        status: "DISQUALIFIED",
        reviewedAt: new Date(),
        reviewReason: "Compliance disqualified the entrant before provider capture settled.",
      },
    });

    const captured = await settleStripeCheckoutCapture({
      tenantId: tenant.id,
      orderId: pending.id,
      providerCheckoutId,
      providerPaymentId: `pi_disqualified_${randomUUID()}`,
      providerEventId: `checkout:${providerCheckoutId}`,
      orderFingerprint: pending.checkoutFingerprint!,
      capturedAmountCents: pending.totalCents,
      currency: pending.currency,
      occurredAt: new Date(),
      payloadHash: "e".repeat(64),
      idempotencyKey: `stripe-checkout-capture:${providerCheckoutId}`,
    });

    expect(captured).toMatchObject({ orderId: pending.id, entries: 0n, receiptStatus: "CAPTURED" });
    expect(await db.order.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({
      status: "CONFIRMED",
      paymentStatus: "CAPTURED",
      entryTotal: 0n,
      inventoryReservationStatus: "COMMITTED",
    });
    expect(await db.payment.count({ where: { orderId: pending.id, status: "CAPTURED" } })).toBe(1);
    expect(await db.entryEntitlement.count({ where: { orderId: pending.id } })).toBe(0);
    expect(await db.entryLedgerEvent.count({ where: { entitlement: { orderId: pending.id } } })).toBe(0);
    expect(await db.auditEvent.count({
      where: { resourceId: pending.id, action: "STRIPE_ORDER_ENTRIES_WITHHELD" },
    })).toBe(1);
    expect(await db.productVariant.findUniqueOrThrow({ where: { id: product.variants[0].id } }))
      .toMatchObject({ inventory: 2, reservedInventory: 0 });
  });

  test("expiry cleanup verifies Stripe state before releasing inventory", async () => {
    const { tenant } = await createPromotion();
    const product = await createProduct({
      tenantId: tenant.id,
      priceCents: 2_500,
      productType: "PHYSICAL",
      inventory: 5,
    });
    const paidSessionId = `cs_paid_${randomUUID()}`;
    const expiredSessionId = `cs_expired_${randomUUID()}`;
    const unavailableSessionId = `cs_unavailable_${randomUUID()}`;
    const boundary = (providerCheckoutId: string) => ({
      async createForPreparedOrder() {
        return {
          providerCheckoutId,
          redirectUrl: `https://checkout.stripe.test/${providerCheckoutId}`,
        };
      },
    });
    await startStripeCheckout(checkoutInput({
      email: "delayed-paid-webhook@example.test",
      lines: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1 }],
    }), tenant.slug, boundary(paidSessionId));
    await startStripeCheckout(checkoutInput({
      email: "expired-without-webhook@example.test",
      lines: [{ productId: product.id, variantId: product.variants[0].id, quantity: 2 }],
    }), tenant.slug, boundary(expiredSessionId));
    await startStripeCheckout(checkoutInput({
      email: "provider-unavailable@example.test",
      lines: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1 }],
    }), tenant.slug, boundary(unavailableSessionId));

    const now = new Date();
    await db.order.updateMany({
      where: { providerCheckoutId: { in: [paidSessionId, expiredSessionId, unavailableSessionId] } },
      data: { checkoutExpiresAt: new Date(now.getTime() - 20 * 60 * 1000) },
    });
    const queriedSessions: string[] = [];
    const released = await releaseExpiredStripeCheckoutOrders(now, 100, async (providerCheckoutId) => {
      queriedSessions.push(providerCheckoutId);
      if (providerCheckoutId === paidSessionId) return { status: "complete", paymentStatus: "paid" };
      if (providerCheckoutId === expiredSessionId) return { status: "expired", paymentStatus: "unpaid" };
      throw new Error("Stripe is temporarily unavailable");
    });

    expect(queriedSessions).toEqual(expect.arrayContaining([
      paidSessionId,
      expiredSessionId,
      unavailableSessionId,
    ]));
    expect(released).toEqual({ scanned: 3, released: 1, skipped: 1, failures: 1 });
    expect(await db.order.findUniqueOrThrow({ where: { providerCheckoutId: paidSessionId } }))
      .toMatchObject({ status: "PENDING", paymentStatus: "UNPAID", inventoryReservationStatus: "HELD" });
    expect(await db.order.findUniqueOrThrow({ where: { providerCheckoutId: expiredSessionId } }))
      .toMatchObject({ status: "CANCELLED", paymentStatus: "UNPAID", inventoryReservationStatus: "RELEASED" });
    expect(await db.order.findUniqueOrThrow({ where: { providerCheckoutId: unavailableSessionId } }))
      .toMatchObject({ status: "PENDING", paymentStatus: "UNPAID", inventoryReservationStatus: "HELD" });
    expect(await db.productVariant.findUniqueOrThrow({ where: { id: product.variants[0].id } }))
      .toMatchObject({ inventory: 5, reservedInventory: 2 });
    expect(await db.payment.count({
      where: { order: { providerCheckoutId: { in: [paidSessionId, expiredSessionId, unavailableSessionId] } } },
    })).toBe(0);
    expect(await db.entryEntitlement.count({
      where: { order: { providerCheckoutId: { in: [paidSessionId, expiredSessionId, unavailableSessionId] } } },
    })).toBe(0);
  });

  test("AMOE enforces normalized-email/day uniqueness and posts the configured award", async () => {
    const { tenant, campaign } = await createPromotion({ amoeEntries: 25_000n });
    const input = freeEntryInput(campaign.slug, "Daily.Entry@Example.Test");

    const first = await submitFreeEntry(input, tenant.id);
    await expect(submitFreeEntry({ ...input, email: "daily.entry@example.test" }, tenant.id))
      .rejects.toThrow(/one free-entry submission per email.*campaign calendar day/i);

    expect(first).toMatchObject({ entries: 25_000n, status: "APPROVED" });
    expect(first.confirmationCode).toMatch(/^FREE-[A-F0-9]{10}$/);
    expect(await db.freeEntrySubmission.count({ where: { campaignId: campaign.id } })).toBe(1);
    const account = await db.entryAccount.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(account.balance).toBe(25_000n);
    expect(await db.entryEntitlement.count({ where: { entryAccountId: account.id, originType: "FREE_ENTRY" } })).toBe(1);
    expect(await db.rulesAcceptance.count({ where: { campaignId: campaign.id, method: "FREE_ENTRY" } })).toBe(1);
  });

  test("structured location eligibility rejects excluded states and normalizes full state names on both entry paths", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 10 });
    await db.campaign.update({
      where: { id: campaign.id },
      data: {
        eligibleCountriesJson: JSON.stringify(["US"]),
        eligibleRegionsJson: JSON.stringify([]),
        excludedRegionsJson: JSON.stringify(["AK", "HI"]),
      },
    });
    const product = await createProduct({ tenantId: tenant.id, priceCents: 10_000 });
    const line = [{ productId: product.id, variantId: product.variants[0].id, quantity: 1 }];

    await expect(completeDemoCheckout({
      ...checkoutInput({ email: "excluded-purchase@example.test", lines: line }),
      region: "Alaska",
    }, tenant.slug)).rejects.toThrow(/location is not eligible/i);
    await expect(submitFreeEntry({
      ...freeEntryInput(campaign.slug, "excluded-free@example.test"),
      region: "Hawaii",
    }, tenant.id)).rejects.toThrow(/location is not eligible/i);
    expect(await db.order.count({ where: { tenantId: tenant.id } })).toBe(0);
    expect(await db.freeEntrySubmission.count({ where: { tenantId: tenant.id } })).toBe(0);

    const purchase = await completeDemoCheckout({
      ...checkoutInput({ email: "normalized-purchase@example.test", lines: line }),
      region: "Colorado",
    }, tenant.slug);
    const order = await db.order.findFirstOrThrow({
      where: { tenantId: tenant.id, orderNumber: purchase.orderNumber },
    });
    expect(JSON.parse(order.shippingAddressJson)).toMatchObject({ country: "US", region: "CO" });
    expect((await db.entrant.findFirstOrThrow({
      where: { tenantId: tenant.id, normalizedEmail: "normalized-purchase@example.test" },
    })).region).toBe("CO");

    const free = await submitFreeEntry({
      ...freeEntryInput(campaign.slug, "normalized-free@example.test"),
      region: "Colorado",
    }, tenant.id);
    const submission = await db.freeEntrySubmission.findUniqueOrThrow({
      where: { confirmationCode: free.confirmationCode },
    });
    expect(JSON.parse(submission.eligibilityJson)).toMatchObject({ country: "US", region: "CO" });
  });

  test("checkout and free entry persist one canonical contact phone and invalid phones write nothing", async () => {
    const { tenant, campaign } = await createPromotion();
    const product = await createProduct({ tenantId: tenant.id, priceCents: 2_500 });
    const lines = [{ productId: product.id, variantId: product.variants[0].id, quantity: 1 }];

    const guestEmail = "canonical-phone-guest@example.test";
    const guestCheckout = await completeDemoCheckout({
      ...checkoutInput({ email: guestEmail, lines }),
      phone: "+1 (720) 555-0188",
    }, tenant.slug);
    await submitFreeEntry({
      ...freeEntryInput(campaign.slug, guestEmail),
      phone: "+1 720.555.0188",
    }, tenant.id);
    const guestEntrants = await db.entrant.findMany({
      where: { tenantId: tenant.id, normalizedEmail: guestEmail },
    });
    expect(guestEntrants).toHaveLength(1);
    expect(guestEntrants[0]!.phone).toBe("+17205550188");
    const guestOrder = await db.order.findFirstOrThrow({
      where: { tenantId: tenant.id, orderNumber: guestCheckout.orderNumber },
    });
    expect(JSON.parse(guestOrder.shippingAddressJson)).toMatchObject({ phone: "+17205550188" });

    const memberEmail = "canonical-phone-member@example.test";
    const member = await db.user.create({
      data: {
        tenantId: tenant.id,
        email: memberEmail,
        normalizedEmail: memberEmail,
        name: "Verified Phone Member",
        passwordHash: "not-used-by-service-test",
        role: "CUSTOMER",
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
      },
    });
    const memberEntrant = await db.entrant.create({
      data: {
        tenantId: tenant.id,
        userId: member.id,
        normalizedEmail: memberEmail,
        emailHash: createHash("sha256").update(memberEmail).digest("hex"),
        name: member.name,
        phone: "7205550100",
      },
    });
    const identity = {
      tenantId: tenant.id,
      userId: member.id,
      entrantId: memberEntrant.id,
      normalizedEmail: memberEmail,
    };
    await completeDemoCheckout({
      ...checkoutInput({ email: memberEmail, lines }),
      phone: "(720) 555-0199",
    }, tenant.slug, identity);
    await submitFreeEntry({
      ...freeEntryInput(campaign.slug, memberEmail),
      phone: "720.555.0199",
    }, tenant.id, identity);
    expect(await db.entrant.findUniqueOrThrow({ where: { id: memberEntrant.id } }))
      .toMatchObject({
        phone: "7205550199",
        userId: member.id,
        region: "CO",
        postalCode: "80202",
        country: "US",
        eligibilityAttested: true,
      });
    expect(await db.entrant.count({ where: { tenantId: tenant.id, normalizedEmail: memberEmail } })).toBe(1);

    const protectedEmail = "protected-phone-member@example.test";
    const protectedMember = await db.user.create({
      data: {
        tenantId: tenant.id,
        email: protectedEmail,
        normalizedEmail: protectedEmail,
        name: "Protected Phone Member",
        passwordHash: "not-used-by-service-test",
        role: "CUSTOMER",
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
      },
    });
    const protectedEntrant = await db.entrant.create({
      data: {
        tenantId: tenant.id,
        userId: protectedMember.id,
        normalizedEmail: protectedEmail,
        emailHash: createHash("sha256").update(protectedEmail).digest("hex"),
        name: protectedMember.name,
        phone: "+17205550111",
      },
    });
    const protectedCheckout = await completeDemoCheckout({
      ...checkoutInput({ email: protectedEmail, lines }),
      name: "Unverified Submitter",
      phone: "+1 (720) 555-0222",
    }, tenant.slug);
    const protectedFree = await submitFreeEntry({
      ...freeEntryInput(campaign.slug, protectedEmail),
      name: "Another Unverified Submitter",
      phone: "+1 (720) 555-0333",
    }, tenant.id);
    expect(await db.entrant.findUniqueOrThrow({ where: { id: protectedEntrant.id } }))
      .toMatchObject({ name: protectedMember.name, phone: "+17205550111", userId: protectedMember.id });
    const protectedOrder = await db.order.findFirstOrThrow({
      where: { tenantId: tenant.id, orderNumber: protectedCheckout.orderNumber },
    });
    expect(JSON.parse(protectedOrder.shippingAddressJson)).toMatchObject({ phone: "+17205550222" });
    const protectedSubmission = await db.freeEntrySubmission.findUniqueOrThrow({
      where: { confirmationCode: protectedFree.confirmationCode },
    });
    expect(JSON.parse(protectedSubmission.eligibilityJson)).toMatchObject({ contactPhone: "+17205550333" });

    const badCheckoutEmail = "bad-phone-checkout@example.test";
    await expect(completeDemoCheckout({
      ...checkoutInput({ email: badCheckoutEmail, lines }),
      phone: "555-CALL-NOW",
    }, tenant.slug)).rejects.toThrow();
    const badFreeEmail = "bad-phone-free@example.test";
    await expect(submitFreeEntry({
      ...freeEntryInput(campaign.slug, badFreeEmail),
      phone: "12345",
    }, tenant.id)).rejects.toThrow();
    expect(await db.entrant.count({
      where: { tenantId: tenant.id, normalizedEmail: { in: [badCheckoutEmail, badFreeEmail] } },
    })).toBe(0);
    expect(await db.order.count({ where: { tenantId: tenant.id, email: badCheckoutEmail } })).toBe(0);
    expect(await db.freeEntrySubmission.count({
      where: { tenantId: tenant.id, entrant: { normalizedEmail: badFreeEmail } },
    })).toBe(0);
  });

  test("checkout rejects an existing disqualified campaign entrant without writing an order", async () => {
    const { tenant, campaign } = await createPromotion();
    const product = await createProduct({ tenantId: tenant.id, priceCents: 2_500 });
    const email = "disqualified-checkout@example.test";
    const user = await db.user.create({
      data: {
        tenantId: tenant.id,
        email,
        normalizedEmail: email,
        name: "Disqualified Entrant",
        passwordHash: "not-used-by-service-test",
        role: "CUSTOMER",
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
      },
    });
    const entrant = await db.entrant.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        normalizedEmail: email,
        emailHash: createHash("sha256").update(email).digest("hex"),
        name: user.name,
        phone: "+13035550148",
      },
    });
    await db.campaignEntrant.create({
      data: { campaignId: campaign.id, entrantId: entrant.id, status: "DISQUALIFIED" },
    });

    await expect(completeDemoCheckout(checkoutInput({
      email,
      lines: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1 }],
    }), tenant.slug, {
      tenantId: tenant.id,
      userId: user.id,
      entrantId: entrant.id,
      normalizedEmail: email,
    })).rejects.toThrow(/entrant is not eligible/i);
    expect(await db.order.count({ where: { tenantId: tenant.id } })).toBe(0);
    expect(await db.entryAccount.count({ where: { campaignId: campaign.id, entrantId: entrant.id } })).toBe(0);
    expect(await db.campaignEntrant.findUniqueOrThrow({
      where: { campaignId_entrantId: { campaignId: campaign.id, entrantId: entrant.id } },
    })).toMatchObject({ status: "DISQUALIFIED" });
  });

  test("snapshot construction waits for the later independent free-entry cutoff", async () => {
    const { tenant, campaign } = await createPromotion({ status: "ENTRY_CLOSED" });
    const operations = await createStaff(tenant.id, "OPERATIONS");
    await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, balance: 10n });
    await db.campaign.update({
      where: { id: campaign.id },
      data: {
        status: "ENTRY_CLOSED",
        endsAt: new Date(Date.now() - 60_000),
        freeEntryEndsAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    await expect(buildEntrySnapshot(campaign.id, operations.id)).rejects.toThrow(/entry period is still open/i);
    expect(await db.entrySnapshot.count({ where: { campaignId: campaign.id } })).toBe(0);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("ENTRY_CLOSED");
  });

  test("free entry uses the explicit request tenant and enqueues receipt and rejection notices", async () => {
    const [{ tenant: firstTenant, campaign: firstCampaign }, { tenant: requestTenant, campaign: requestCampaign }] = await Promise.all([
      createPromotion(),
      createPromotion(),
    ]);
    await db.campaign.update({
      where: { id: requestCampaign.id },
      data: { slug: firstCampaign.slug },
    });
    const previousDemoMode = process.env.DEMO_MODE;
    process.env.DEMO_MODE = "false";
    try {
      const reviewer = await createStaff(requestTenant.id, "OPERATIONS");
      const receipt = await submitFreeEntry(
        freeEntryInput(firstCampaign.slug, "tenant-isolation@example.test"),
        requestTenant.id,
      );
      expect(receipt.status).toBe("PENDING");
      const submission = await db.freeEntrySubmission.findUniqueOrThrow({
        where: { confirmationCode: receipt.confirmationCode },
      });
      expect(submission).toMatchObject({ tenantId: requestTenant.id, campaignId: requestCampaign.id });
      expect(await db.freeEntrySubmission.count({ where: { tenantId: firstTenant.id } })).toBe(0);

      await reviewFreeEntry({
        tenantId: requestTenant.id,
        submissionId: submission.id,
        actorId: reviewer.id,
        decision: "REJECT",
        reason: "Integration test rejection after manual review",
      });
      const notifications = await db.outboxEvent.findMany({
        where: { tenantId: requestTenant.id, aggregateId: submission.id },
        orderBy: { kind: "asc" },
      });
      expect(notifications.map((event) => event.kind)).toEqual([
        "FREE_ENTRY_RECEIPT",
        "FREE_ENTRY_REVIEWED_NOTIFICATION",
      ]);
      expect(notifications.every((event) => (
        event.aggregateType === "FreeEntrySubmission" && event.aggregateId === submission.id
      ))).toBe(true);

      const blockedReceipt = await submitFreeEntry(
        freeEntryInput(firstCampaign.slug, "disqualified-review@example.test"),
        requestTenant.id,
      );
      const blocked = await db.freeEntrySubmission.findUniqueOrThrow({
        where: { confirmationCode: blockedReceipt.confirmationCode },
      });
      await db.campaignEntrant.update({
        where: {
          campaignId_entrantId: {
            campaignId: blocked.campaignId,
            entrantId: blocked.entrantId,
          },
        },
        data: { status: "DISQUALIFIED" },
      });
      await expect(reviewFreeEntry({
        tenantId: requestTenant.id,
        submissionId: blocked.id,
        actorId: reviewer.id,
        decision: "APPROVE",
        reason: "Should fail after later eligibility review",
      })).rejects.toThrow(/not eligible/i);
      await expect(reviewFreeEntry({
        tenantId: requestTenant.id,
        submissionId: blocked.id,
        actorId: "untrusted-caller-supplied-id",
        decision: "REJECT",
        reason: "Should fail without an authorized actor",
      })).rejects.toThrow(/authorized staff/i);
      expect(await db.entryEntitlement.count({ where: { freeEntrySubmissionId: blocked.id } })).toBe(0);
    } finally {
      process.env.DEMO_MODE = previousDemoMode;
    }
  });

  test("email outbox claims once, escapes aggregate content, retries, and dead-letters safely", async () => {
    const now = new Date();
    await db.outboxEvent.updateMany({
      where: { status: { in: ["PENDING", "FAILED", "PROCESSING"] } },
      data: { nextAttemptAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) },
    });
    const { tenant } = await createPromotion();
    const ticket = await db.supportTicket.create({
      data: {
        tenantId: tenant.id,
        name: "<script>alert('name')</script>",
        email: "notification-worker@example.test",
        subject: "<img src=x onerror=alert('subject')>",
        message: "A sufficiently long integration-test support message.",
      },
    });
    const event = await db.outboxEvent.create({
      data: {
        tenantId: tenant.id,
        aggregateType: "SupportTicket",
        aggregateId: ticket.id,
        kind: "SUPPORT_ACKNOWLEDGMENT_EMAIL",
        payloadJson: JSON.stringify({ supportTicketId: "untrusted-payload-id" }),
        idempotencyKey: `support-acknowledgment:${ticket.id}`,
        nextAttemptAt: now,
      },
    });
    const transientProvider: EmailNotificationProvider = {
      async send() {
        throw new NotificationDeliveryError("provider_rate_limited", true);
      },
    };

    const first = await processEmailOutboxBatch({ now, provider: transientProvider });
    expect(first).toMatchObject({ claimed: 1, accepted: 0, retried: 1, deadLettered: 0 });
    const failed = await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(failed).toMatchObject({ status: "FAILED", attempts: 1, lastError: "provider_rate_limited" });
    expect(failed.lastError).not.toContain(ticket.email);
    expect(failed.nextAttemptAt.getTime()).toBe(now.getTime() + 60_000);
    expect((await processEmailOutboxBatch({ now, provider: transientProvider })).scanned).toBe(0);

    const accepted: Array<{ html: string; text: string; idempotencyKey: string }> = [];
    const acceptingProvider: EmailNotificationProvider = {
      async send(email, idempotencyKey) {
        accepted.push({ html: email.html, text: email.text, idempotencyKey });
        return { providerMessageId: "email_integration_123" };
      },
    };
    const retryAt = failed.nextAttemptAt;
    const batches = await Promise.all([
      processEmailOutboxBatch({ now: retryAt, provider: acceptingProvider }),
      processEmailOutboxBatch({ now: retryAt, provider: acceptingProvider }),
    ]);
    expect(batches.reduce((total, batch) => total + batch.claimed, 0)).toBe(1);
    expect(batches.reduce((total, batch) => total + batch.accepted, 0)).toBe(1);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].idempotencyKey).toMatch(new RegExp(`^outbox/${event.id}/`));
    expect(accepted[0].html).not.toContain("<script>");
    expect(accepted[0].html).not.toContain("<img");
    expect(accepted[0].html).toContain("&lt;script&gt;");
    expect(accepted[0].html).toContain("&lt;img");
    expect((await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })))
      .toMatchObject({ status: "PROCESSED", attempts: 2, lastError: null });

    const invalid = await db.outboxEvent.create({
      data: {
        tenantId: tenant.id,
        aggregateType: "Order",
        aggregateId: ticket.id,
        kind: "SUPPORT_ACKNOWLEDGMENT_EMAIL",
        payloadJson: JSON.stringify({ supportTicketId: ticket.id }),
        idempotencyKey: `invalid-support-acknowledgment:${ticket.id}`,
        nextAttemptAt: retryAt,
      },
    });
    const permanent = await processEmailOutboxBatch({ now: retryAt, provider: acceptingProvider });
    expect(permanent).toMatchObject({ claimed: 1, accepted: 0, deadLettered: 1 });
    expect(accepted).toHaveLength(1);
    expect(await db.outboxEvent.findUniqueOrThrow({ where: { id: invalid.id } }))
      .toMatchObject({
        status: "DEAD_LETTER",
        attempts: 1,
        lastError: "notification_aggregate_type_mismatch",
      });

    const exhausted = await db.outboxEvent.create({
      data: {
        tenantId: tenant.id,
        aggregateType: "SupportTicket",
        aggregateId: ticket.id,
        kind: "SUPPORT_ACKNOWLEDGMENT_EMAIL",
        payloadJson: JSON.stringify({ supportTicketId: ticket.id }),
        idempotencyKey: `exhausted-support-acknowledgment:${ticket.id}`,
        status: "PROCESSING",
        attempts: 5,
        nextAttemptAt: retryAt,
      },
    });
    expect(await processEmailOutboxBatch({ now: retryAt, provider: acceptingProvider }))
      .toMatchObject({ claimed: 0, accepted: 0, deadLettered: 1 });
    expect(accepted).toHaveLength(1);
    expect(await db.outboxEvent.findUniqueOrThrow({ where: { id: exhausted.id } }))
      .toMatchObject({
        status: "DEAD_LETTER",
        attempts: 5,
        lastError: "email_delivery_attempts_exhausted",
      });
  });

  test("public rate-limit counters isolate tenants and maintenance prunes expired windows", async () => {
    const [{ tenant: firstTenant }, { tenant: secondTenant }] = await Promise.all([
      createPromotion(),
      createPromotion(),
    ]);
    const now = new Date();
    const rules = publicRateLimitRules({
      scope: "integration:public-action",
      subject: "limited-person@example.test",
      subjectLimit: 1,
      ip: "192.0.2.50",
      ipLimit: 2,
      windowSeconds: 60 * 60,
    });
    expect((await consumeRateLimits({ tenantId: firstTenant.id, rules, now })).allowed).toBe(true);
    expect((await consumeRateLimits({ tenantId: firstTenant.id, rules, now })).allowed).toBe(false);
    expect((await consumeRateLimits({ tenantId: secondTenant.id, rules, now })).allowed).toBe(true);

    const currentBuckets = await db.rateLimitBucket.findMany({
      where: { tenantId: { in: [firstTenant.id, secondTenant.id] } },
      orderBy: [{ tenantId: "asc" }, { scope: "asc" }],
    });
    expect(currentBuckets).toHaveLength(4);
    expect(currentBuckets.filter((bucket) => bucket.tenantId === firstTenant.id).map((bucket) => bucket.count))
      .toEqual([2, 2]);
    expect(currentBuckets.filter((bucket) => bucket.tenantId === secondTenant.id).map((bucket) => bucket.count))
      .toEqual([1, 1]);
    expect(currentBuckets.every((bucket) => (
      !bucket.identifierHash.includes("limited-person") && !bucket.identifierHash.includes("192.0.2.50")
    ))).toBe(true);

    await consumeRateLimits({
      tenantId: firstTenant.id,
      now: new Date(now.getTime() - 72 * 60 * 60 * 1000),
      rules: publicRateLimitRules({
        scope: "integration:expired",
        subject: "expired-person@example.test",
        subjectLimit: 5,
        ip: null,
        ipLimit: 5,
        windowSeconds: 60 * 60,
      }),
    });
    const previousResendKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "";
    try {
      const maintenance = await runMaintenance(now);
      expect(maintenance.rateLimitBucketsPruned).toBe(1);
      expect(maintenance.emailDelivery.configured).toBe(false);
    } finally {
      if (previousResendKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = previousResendKey;
    }
    expect(await db.rateLimitBucket.count({
      where: { windowStart: { lt: new Date(now.getTime() - 48 * 60 * 60 * 1000) } },
    })).toBe(0);
    expect(await db.rateLimitBucket.count({
      where: { tenantId: { in: [firstTenant.id, secondTenant.id] } },
    })).toBe(4);
  });

  test("purchase and free entry converge on one account and one shared cap", async () => {
    const { tenant, campaign } = await createPromotion({
      multiplier: 100,
      amoeEntries: 25_000n,
      maxEntries: 30_000n,
    });
    const product = await createProduct({ tenantId: tenant.id, priceCents: 10_000 });
    const email = "shared-pool@example.test";
    const purchase = await completeDemoCheckout(checkoutInput({
      email,
      lines: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1 }],
    }), tenant.slug);
    const free = await submitFreeEntry(freeEntryInput(campaign.slug, email), tenant.id);

    expect(purchase.entries).toBe(10_000n);
    expect(free.entries).toBe(20_000n);
    expect(await db.entrant.count({ where: { tenantId: tenant.id, normalizedEmail: email } })).toBe(1);
    const accounts = await db.entryAccount.findMany({ where: { campaignId: campaign.id } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0].balance).toBe(30_000n);
    const entitlements = await db.entryEntitlement.findMany({ where: { entryAccountId: accounts[0].id } });
    expect(new Set(entitlements.map((item) => item.originType))).toEqual(new Set(["ORDER_LINE", "FREE_ENTRY"]));
  });

  test("SQLite hardening rejects zero-value, mutable, or negative ledger state", async () => {
    const { tenant, campaign } = await createPromotion();
    const { account } = await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id });
    const event = await db.entryLedgerEvent.create({
      data: {
        tenantId: tenant.id,
        entryAccountId: account.id,
        kind: "GRANT",
        delta: 1n,
        idempotencyKey: `hardening:${randomUUID()}`,
        effectiveAt: new Date(),
        reasonCode: "HARDENING_TEST",
      },
    });
    await db.entryAccount.update({ where: { id: account.id }, data: { balance: 1n } });
    const audit = await db.auditEvent.create({
      data: {
        tenantId: tenant.id,
        actorType: "SYSTEM",
        action: "HARDENING_TEST",
        resourceType: "EntryLedgerEvent",
        resourceId: event.id,
      },
    });

    await expect(db.entryLedgerEvent.create({
      data: {
        tenantId: tenant.id,
        entryAccountId: account.id,
        kind: "GRANT",
        delta: 0n,
        idempotencyKey: `zero:${randomUUID()}`,
        effectiveAt: new Date(),
        reasonCode: "ZERO_TEST",
      },
    })).rejects.toThrow();
    await expect(db.entryLedgerEvent.update({ where: { id: event.id }, data: { reasonCode: "REWRITTEN" } }))
      .rejects.toThrow();
    await expect(db.entryLedgerEvent.delete({ where: { id: event.id } })).rejects.toThrow();
    await expect(db.entryAccount.update({ where: { id: account.id }, data: { balance: -1n } }))
      .rejects.toThrow();
    await expect(db.auditEvent.update({ where: { id: audit.id }, data: { action: "REWRITTEN" } }))
      .rejects.toThrow();
    await expect(db.auditEvent.delete({ where: { id: audit.id } })).rejects.toThrow();
    expect((await db.entryLedgerEvent.findUniqueOrThrow({ where: { id: event.id } })).reasonCode).toBe("HARDENING_TEST");
    expect((await db.entryAccount.findUniqueOrThrow({ where: { id: account.id } })).balance).toBe(1n);
  });

  test("partial refunds converge exactly to a full reversal and replay safely", async () => {
    const { tenant } = await createPromotion({ multiplier: 10 });
    const [large, small] = await Promise.all([
      createProduct({ tenantId: tenant.id, priceCents: 10_000 }),
      createProduct({ tenantId: tenant.id, priceCents: 5_000 }),
    ]);
    const checkout = await completeDemoCheckout(checkoutInput({
      email: "refunds@example.test",
      lines: [
        { productId: large.id, variantId: large.variants[0].id, quantity: 1 },
        { productId: small.id, variantId: small.variants[0].id, quantity: 1 },
      ],
    }), tenant.slug);
    const order = await db.order.findFirstOrThrow({ where: { tenantId: tenant.id, orderNumber: checkout.orderNumber } });

    const first = await settleDemoRefund({
      orderId: order.id,
      amountCents: 7_500,
      reason: "First half returned in integration test",
      actorId: "refund-operator",
      idempotencyKey: `refund-half:${randomUUID()}`,
    });
    const replay = await settleDemoRefund({
      orderId: order.id,
      amountCents: 7_500,
      reason: "First half returned in integration test",
      actorId: "refund-operator",
      idempotencyKey: first.idempotencyKey,
    });
    expect(replay.id).toBe(first.id);
    expect(sum(first.allocations.map((item) => item.entriesReversed))).toBe(750n);
    expect((await db.entryAccount.findFirstOrThrow({ where: { tenantId: tenant.id } })).balance).toBe(750n);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe("PARTIALLY_REFUNDED");

    const second = await settleDemoRefund({
      orderId: order.id,
      amountCents: 7_500,
      reason: "Remaining half returned in integration test",
      actorId: "refund-operator",
      idempotencyKey: `refund-rest:${randomUUID()}`,
    });
    expect(sum(second.allocations.map((item) => item.entriesReversed))).toBe(750n);
    const account = await db.entryAccount.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const events = await db.entryLedgerEvent.findMany({ where: { entryAccountId: account.id } });
    expect(account.balance).toBe(0n);
    expect(sum(events.map((event) => event.delta))).toBe(0n);
    expect(await db.refund.count({ where: { orderId: order.id } })).toBe(2);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe("REFUNDED");
    expect((await db.payment.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe("REFUNDED");
  });

  test("distinct concurrent refunds serialize against fresh allocations and converge exactly", async () => {
    const { tenant } = await createPromotion({ multiplier: 10 });
    const [large, small] = await Promise.all([
      createProduct({ tenantId: tenant.id, priceCents: 10_001 }),
      createProduct({ tenantId: tenant.id, priceCents: 5_002 }),
    ]);
    const checkout = await completeDemoCheckout(checkoutInput({
      email: "concurrent-refunds@example.test",
      lines: [
        { productId: large.id, variantId: large.variants[0].id, quantity: 1 },
        { productId: small.id, variantId: small.variants[0].id, quantity: 1 },
      ],
    }), tenant.slug);
    const order = await db.order.findFirstOrThrow({
      where: { tenantId: tenant.id, orderNumber: checkout.orderNumber },
      include: { lines: true },
    });

    const refunds = await Promise.all([
      settleDemoRefund({
        orderId: order.id,
        amountCents: 7_501,
        reason: "Concurrent refund first portion in integration test",
        actorId: "refund-operator-a",
        idempotencyKey: `refund-race-a:${randomUUID()}`,
      }),
      settleDemoRefund({
        orderId: order.id,
        amountCents: 7_502,
        reason: "Concurrent refund second portion in integration test",
        actorId: "refund-operator-b",
        idempotencyKey: `refund-race-b:${randomUUID()}`,
      }),
    ]);

    expect(new Set(refunds.map((refund) => refund.id)).size).toBe(2);
    const persisted = await db.refund.findMany({
      where: { orderId: order.id, status: "COMPLETED" },
      include: { allocations: true },
    });
    expect(persisted).toHaveLength(2);
    expect(persisted.reduce((total, refund) => total + refund.amountCents, 0)).toBe(15_003);
    for (const line of order.lines) {
      const allocations = persisted.flatMap((refund) => refund.allocations)
        .filter((allocation) => allocation.orderLineId === line.id);
      expect(allocations.reduce((total, allocation) => total + allocation.amountCents, 0))
        .toBe(line.qualifyingCents);
      expect(sum(allocations.map((allocation) => allocation.entriesReversed))).toBe(line.entries);
    }
    const account = await db.entryAccount.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const events = await db.entryLedgerEvent.findMany({ where: { entryAccountId: account.id } });
    expect(account.balance).toBe(0n);
    expect(sum(events.map((event) => event.delta))).toBe(0n);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe("REFUNDED");
    expect((await db.payment.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe("REFUNDED");
  });

  test("refund money is recorded while snapshot review defers only the entry consequence", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 10 });
    const product = await createProduct({ tenantId: tenant.id, priceCents: 10_000 });
    const checkout = await completeDemoCheckout(checkoutInput({
      email: "snapshot-review-refund@example.test",
      lines: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1 }],
    }), tenant.slug);
    const order = await db.order.findFirstOrThrow({
      where: { tenantId: tenant.id, orderNumber: checkout.orderNumber },
    });
    await db.campaign.update({
      where: { id: campaign.id },
      data: { status: "SNAPSHOT_REVIEW" },
    });

    const refund = await settleDemoRefund({
      orderId: order.id,
      amountCents: 5_000,
      reason: "Must not mutate a snapshot awaiting approval",
      actorId: "refund-operator",
      idempotencyKey: `refund-snapshot-review:${randomUUID()}`,
    });

    expect(await db.refund.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db.entryAdjustmentRequest.findUniqueOrThrow({ where: { refundId: refund.id } }))
      .toMatchObject({ status: "PENDING", delta: -500n });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe("PARTIALLY_REFUNDED");
    expect((await db.payment.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe("PARTIALLY_REFUNDED");
    expect((await db.entryAccount.findFirstOrThrow({ where: { tenantId: tenant.id } })).balance)
      .toBe(checkout.entries);
  });

  test("Stripe membership enrollment, invoices, portal, and provider state are canonical and idempotent", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 10, maxEntries: 10_000n });
    await db.entryMultiplierPeriod.create({
      data: {
        campaignId: campaign.id,
        label: "Membership integration 2X",
        numerator: 2,
        denominator: 1,
        startsAt: new Date(Date.now() - 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const product = await createProduct({
      tenantId: tenant.id,
      priceCents: 2_500,
      productType: "MEMBERSHIP",
      category: "Membership",
    });
    const user = await db.user.create({
      data: {
        tenantId: tenant.id,
        email: "stripe-member@example.test",
        normalizedEmail: "stripe-member@example.test",
        name: "Stripe Member",
        passwordHash: "not-used-by-service-tests",
        role: "CUSTOMER",
        status: "ACTIVE",
      },
    });
    const entrant = await db.entrant.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        normalizedEmail: user.normalizedEmail,
        emailHash: createHash("sha256").update(user.normalizedEmail).digest("hex"),
        name: user.name,
        region: "CO",
        postalCode: "80202",
        eligibilityAttested: true,
      },
    });
    const plan = await db.subscriptionPlan.create({
      data: {
        tenantId: tenant.id,
        productId: product.id,
        name: "Stripe Monthly",
        interval: "MONTH",
        intervalCount: 1,
        priceCents: 2_500,
        currency: "USD",
        baseEntries: 6_250n,
        providerPriceId: "price_membership_integration",
      },
    });
    await db.membershipEntryBand.create({
      data: {
        campaignId: campaign.id,
        planId: plan.id,
        minimumSettledCycles: 0,
        fixedEntries: 6_250n,
        multiplierNumerator: 3,
        multiplierDenominator: 2,
      },
    });
    await releasePromotionFixture(campaign.id);
    if (!campaign.officialRulesDocumentId || !campaign.officialRulesChecksum) {
      throw new Error("Stripe membership test campaign is missing Official Rules");
    }
    await db.rulesAcceptance.create({
      data: {
        tenantId: tenant.id,
        campaignId: campaign.id,
        entrantId: entrant.id,
        legalDocumentId: campaign.officialRulesDocumentId,
        documentChecksum: campaign.officialRulesChecksum,
        method: "MEMBERSHIP",
      },
    });

    let prepared: PreparedStripeSubscriptionRequest | null = null;
    let portalCustomer: string | null = null;
    const providerCheckoutId = `cs_membership_${randomUUID()}`;
    const boundary = {
      async createEnrollment(request: PreparedStripeSubscriptionRequest) {
        prepared = request;
        return {
          providerCheckoutId,
          redirectUrl: "https://checkout.stripe.test/membership",
        };
      },
      async createBillingPortal(input: { providerCustomerId: string }) {
        portalCustomer = input.providerCustomerId;
        return { redirectUrl: "https://billing.stripe.test/session" };
      },
    };
    const enrollmentKey = `stripe-enroll:${randomUUID()}`;
    const started = await startStripeSubscriptionCheckout({
      tenantId: tenant.id,
      planId: plan.id,
      entrantId: entrant.id,
      userId: user.id,
      idempotencyKey: enrollmentKey,
    }, boundary);
    expect(started).toMatchObject({ redirectUrl: "https://checkout.stripe.test/membership" });
    expect(prepared).toMatchObject({
      tenantId: tenant.id,
      planId: plan.id,
      providerPriceId: plan.providerPriceId,
      priceCents: 2_500,
      currency: "USD",
      billingInterval: "MONTH",
      billingIntervalCount: 1,
    });
    const pending = await db.subscription.findUniqueOrThrow({ where: { id: started.subscriptionId } });
    expect(pending).toMatchObject({
      status: "PENDING",
      provider: "STRIPE",
      providerCheckoutId,
      settledCycleCount: 0,
    });
    expect(await db.subscriptionCycle.count({ where: { subscriptionId: pending.id } })).toBe(0);

    const providerSubscriptionId = `sub_${randomUUID()}`;
    const providerCustomerId = `cus_${randomUUID()}`;
    const initialOccurredAt = new Date();
    const initialPeriodStartsAt = new Date(initialOccurredAt.getTime() - 60_000);
    const initialPeriodEndsAt = new Date(initialPeriodStartsAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    const initialInvoice = {
      tenantId: tenant.id,
      subscriptionId: pending.id,
      subscriptionFingerprint: pending.enrollmentFingerprint!,
      providerSubscriptionId,
      providerCustomerId,
      providerInvoiceId: `in_initial_${randomUUID()}`,
      providerPaymentId: `pi_initial_${randomUUID()}`,
      providerEventId: `invoice:initial:${randomUUID()}`,
      providerPriceId: plan.providerPriceId!,
      billingReason: "subscription_create" as const,
      capturedAmountCents: 2_500,
      currency: "USD",
      periodStartsAt: initialPeriodStartsAt,
      periodEndsAt: initialPeriodEndsAt,
      occurredAt: initialOccurredAt,
      payloadHash: "a".repeat(64),
      idempotencyKey: `stripe-invoice:${randomUUID()}`,
    };
    const initial = await settleStripeSubscriptionInvoice(initialInvoice);
    const initialReplay = await settleStripeSubscriptionInvoice(initialInvoice);
    expect(initial).toMatchObject({ cycleNumber: 1, campaignId: campaign.id, entries: 10_000n, idempotent: false });
    expect(initialReplay).toMatchObject({ orderId: initial.orderId, cycleId: initial.cycleId, idempotent: true });
    const persistedInitialCycle = await db.subscriptionCycle.findUniqueOrThrow({
      where: { id: initial.cycleId },
      include: { order: { include: { lines: true } } },
    });
    expect(persistedInitialCycle).toMatchObject({ multiplierNumerator: 6, multiplierDenominator: 2 });
    expect(persistedInitialCycle.order.lines[0]).toMatchObject({
      entryMultiplier: 6,
      entryMultiplierDenominator: 2,
    });
    expect((await db.subscription.findUniqueOrThrow({ where: { id: pending.id } })))
      .toMatchObject({ status: "ACTIVE", providerSubscriptionId, providerCustomerId, settledCycleCount: 1 });
    expect((await db.entryAccount.findFirstOrThrow({ where: { campaignId: campaign.id } })).balance).toBe(10_000n);
    await expect(settleStripeSubscriptionInvoice({
      ...initialInvoice,
      providerInvoiceId: `in_wrong_price_${randomUUID()}`,
      providerPaymentId: `pi_wrong_price_${randomUUID()}`,
      providerEventId: `invoice:wrong-price:${randomUUID()}`,
      capturedAmountCents: 2_501,
      payloadHash: "c".repeat(64),
      idempotencyKey: `stripe-invoice:${randomUUID()}`,
    })).rejects.toThrow(/immutable membership price/i);

    const enrollmentBinding = await bindStripeSubscriptionEnrollment({
      tenantId: tenant.id,
      subscriptionId: pending.id,
      subscriptionFingerprint: pending.enrollmentFingerprint!,
      providerCheckoutId,
      providerPriceId: plan.providerPriceId!,
      providerSubscriptionId,
      providerCustomerId,
      providerEventId: `evt_checkout_${randomUUID()}`,
      occurredAt: new Date(initialOccurredAt.getTime() + 1_000),
    });
    expect(enrollmentBinding).toMatchObject({ subscriptionId: pending.id });
    const portal = await createStripeBillingPortal({
      tenantId: tenant.id,
      subscriptionId: pending.id,
      userId: user.id,
      idempotencyKey: `portal:${randomUUID()}`,
    }, boundary);
    expect(portal.redirectUrl).toBe("https://billing.stripe.test/session");
    expect(portalCustomer).toBe(providerCustomerId);

    const failedAt = new Date(initialOccurredAt.getTime() + 60 * 60 * 1000);
    const cycleCountBeforeFailure = await db.subscriptionCycle.count({ where: { subscriptionId: pending.id } });
    await failStripeSubscriptionInvoice({
      tenantId: tenant.id,
      subscriptionId: pending.id,
      subscriptionFingerprint: pending.enrollmentFingerprint!,
      providerSubscriptionId,
      providerCustomerId,
      providerPriceId: plan.providerPriceId!,
      providerInvoiceId: `in_failed_${randomUUID()}`,
      providerEventId: `evt_failed_${randomUUID()}`,
      occurredAt: failedAt,
    });
    expect((await db.subscription.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("PAST_DUE");
    expect(await db.subscriptionCycle.count({ where: { subscriptionId: pending.id } })).toBe(cycleCountBeforeFailure);

    const renewalPeriodStartsAt = initialPeriodEndsAt;
    const renewalPeriodEndsAt = new Date(renewalPeriodStartsAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    const renewalOccurredAt = new Date(renewalPeriodStartsAt.getTime() + 10_000);
    const renewal = await settleStripeSubscriptionInvoice({
      ...initialInvoice,
      providerInvoiceId: `in_renewal_${randomUUID()}`,
      providerPaymentId: `pi_renewal_${randomUUID()}`,
      providerEventId: `invoice:renewal:${randomUUID()}`,
      billingReason: "subscription_cycle",
      periodStartsAt: renewalPeriodStartsAt,
      periodEndsAt: renewalPeriodEndsAt,
      occurredAt: renewalOccurredAt,
      payloadHash: "b".repeat(64),
      idempotencyKey: `stripe-invoice:${randomUUID()}`,
    });
    expect(renewal).toMatchObject({ cycleNumber: 2, campaignId: null, entries: 0n });
    expect(await db.payment.count({ where: { orderId: renewal.orderId } })).toBe(1);
    expect(await db.entryEntitlement.count({ where: { orderId: renewal.orderId } })).toBe(0);
    expect(await db.entryLedgerEvent.count({
      where: { metadataJson: { contains: renewal.orderId } },
    })).toBe(0);

    const cancelledAt = new Date(renewalOccurredAt.getTime() + 60_000);
    const cancelled = await applyStripeSubscriptionState({
      tenantId: tenant.id,
      subscriptionId: pending.id,
      subscriptionFingerprint: pending.enrollmentFingerprint!,
      providerSubscriptionId,
      providerCustomerId,
      providerPriceId: plan.providerPriceId!,
      priceCents: 2_500,
      currency: "USD",
      billingInterval: "MONTH",
      billingIntervalCount: 1,
      providerEventId: `evt_deleted_${randomUUID()}`,
      providerStatus: "canceled",
      cancelAtPeriodEnd: false,
      periodStartsAt: renewalPeriodStartsAt,
      periodEndsAt: renewalPeriodEndsAt,
      endedAt: cancelledAt,
      occurredAt: cancelledAt,
    });
    expect(cancelled).toMatchObject({ status: "CANCELLED", idempotent: false });
    const stale = await applyStripeSubscriptionState({
      tenantId: tenant.id,
      subscriptionId: pending.id,
      subscriptionFingerprint: pending.enrollmentFingerprint!,
      providerSubscriptionId,
      providerCustomerId,
      providerPriceId: plan.providerPriceId!,
      priceCents: 2_500,
      currency: "USD",
      billingInterval: "MONTH",
      billingIntervalCount: 1,
      providerEventId: `evt_stale_${randomUUID()}`,
      providerStatus: "active",
      cancelAtPeriodEnd: false,
      periodStartsAt: renewalPeriodStartsAt,
      periodEndsAt: renewalPeriodEndsAt,
      endedAt: null,
      occurredAt: failedAt,
    });
    expect(stale).toMatchObject({ status: "CANCELLED", idempotent: true });

    const { tenant: otherTenant } = await createPromotion();
    await expect(createStripeBillingPortal({
      tenantId: otherTenant.id,
      subscriptionId: pending.id,
      userId: user.id,
      idempotencyKey: `portal-cross-tenant:${randomUUID()}`,
    }, boundary)).rejects.toThrow(/not yet available/i);
    await expect(settleStripeSubscriptionInvoice({
      ...initialInvoice,
      tenantId: otherTenant.id,
    })).rejects.toThrow(/not found/i);
  });

  test("subscription enrollment settles the initial period once and cancellation is idempotent", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 250 });
    const product = await createProduct({
      tenantId: tenant.id,
      priceCents: 2_500,
      productType: "MEMBERSHIP",
      category: "Membership",
    });
    const user = await db.user.create({
      data: {
        tenantId: tenant.id,
        email: "member@example.test",
        normalizedEmail: "member@example.test",
        name: "Member Tester",
        passwordHash: "not-used-by-service-tests",
        role: "CUSTOMER",
        status: "ACTIVE",
      },
    });
    const entrant = await db.entrant.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        normalizedEmail: user.normalizedEmail,
        emailHash: createHash("sha256").update(user.normalizedEmail).digest("hex"),
        name: user.name,
        region: "CO",
        postalCode: "80202",
        eligibilityAttested: true,
      },
    });
    const plan = await db.subscriptionPlan.create({
      data: {
        tenantId: tenant.id,
        productId: product.id,
        name: "Test Monthly",
        interval: "MONTH",
        intervalCount: 1,
        priceCents: 2_500,
        currency: "USD",
        baseEntries: 25n,
      },
    });
    await db.membershipEntryBand.create({
      data: {
        campaignId: campaign.id,
        planId: plan.id,
        minimumSettledCycles: 0,
        fixedEntries: 25n,
      },
    });
    const enrollmentKey = `enroll:${randomUUID()}`;
    const created = await createDemoSubscription({
      tenantId: tenant.id,
      planId: plan.id,
      entrantId: entrant.id,
      userId: user.id,
      idempotencyKey: enrollmentKey,
    });
    const enrollmentReplay = await createDemoSubscription({
      tenantId: tenant.id,
      planId: plan.id,
      entrantId: entrant.id,
      userId: user.id,
      idempotencyKey: enrollmentKey,
    });
    expect(created.idempotent).toBe(false);
    expect(enrollmentReplay).toMatchObject({ subscriptionId: created.subscriptionId, idempotent: true });

    const settlementKey = `initial:${randomUUID()}`;
    const settlement = await settleDemoSubscriptionRenewal({
      tenantId: tenant.id,
      subscriptionId: created.subscriptionId,
      idempotencyKey: settlementKey,
    });
    const settlementReplay = await settleDemoSubscriptionRenewal({
      tenantId: tenant.id,
      subscriptionId: created.subscriptionId,
      idempotencyKey: settlementKey,
    });
    expect(settlement).toMatchObject({ cycleNumber: 1, entries: 6_250n, idempotent: false });
    expect(settlementReplay).toMatchObject({ orderId: settlement.orderId, cycleId: settlement.cycleId, idempotent: true });
    expect(settlement.periodStartsAt).toEqual(created.currentPeriodStartsAt);
    expect(await db.subscriptionCycle.count({ where: { subscriptionId: created.subscriptionId } })).toBe(1);
    expect(await db.order.count({ where: { tenantId: tenant.id, channel: "SUBSCRIPTION" } })).toBe(1);
    expect(await db.payment.count({ where: { orderId: settlement.orderId } })).toBe(1);
    expect((await db.entryAccount.findFirstOrThrow({ where: { campaignId: campaign.id } })).balance).toBe(6_250n);

    const cancellationKey = `cancel:${randomUUID()}`;
    const scheduled = await cancelSubscriptionAtPeriodEnd({
      tenantId: tenant.id,
      subscriptionId: created.subscriptionId,
      idempotencyKey: cancellationKey,
    });
    const scheduledReplay = await cancelSubscriptionAtPeriodEnd({
      tenantId: tenant.id,
      subscriptionId: created.subscriptionId,
      idempotencyKey: cancellationKey,
    });
    expect(scheduled).toMatchObject({ cancelAtPeriodEnd: true, finalized: false, idempotent: false });
    expect(scheduledReplay).toMatchObject({ cancelAtPeriodEnd: true, finalized: false, idempotent: true });
    await expect(settleDemoSubscriptionRenewal({
      tenantId: tenant.id,
      subscriptionId: created.subscriptionId,
      idempotencyKey: `renew-after-cancel:${randomUUID()}`,
    })).rejects.toThrow(/scheduled to cancel/i);
    expect((await finalizeSubscriptionCancellation({
      tenantId: tenant.id,
      subscriptionId: created.subscriptionId,
    })).finalized).toBe(false);

    const effectiveAt = new Date(Date.now() - 1_000);
    await db.subscription.update({
      where: { id: created.subscriptionId },
      data: { currentPeriodEndsAt: effectiveAt },
    });
    const finalized = await finalizeSubscriptionCancellation({
      tenantId: tenant.id,
      subscriptionId: created.subscriptionId,
    });
    const finalizedReplay = await finalizeSubscriptionCancellation({
      tenantId: tenant.id,
      subscriptionId: created.subscriptionId,
    });
    expect(finalized).toMatchObject({ status: "CANCELLED", finalized: true, idempotent: false, cancelledAt: effectiveAt });
    expect(finalizedReplay).toMatchObject({ status: "CANCELLED", finalized: true, idempotent: true, cancelledAt: effectiveAt });
  });

  test("every existing transactional email kind renders from its authoritative aggregate", async () => {
    const now = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const pending = await db.outboxEvent.findMany({
      where: {
        kind: { in: [...EMAIL_OUTBOX_KINDS] },
        status: { in: ["PENDING", "FAILED", "PROCESSING"] },
        nextAttemptAt: { lte: now },
      },
      select: { id: true, kind: true },
      orderBy: { id: "asc" },
    });
    expect(new Set(pending.map((event) => event.kind))).toEqual(new Set([
      "ORDER_CONFIRMATION_EMAIL",
      "FREE_ENTRY_RECEIPT",
      "FREE_ENTRY_REVIEWED_NOTIFICATION",
      "SUBSCRIPTION_CREATED_NOTIFICATION",
      "SUBSCRIPTION_RENEWAL_RECEIPT",
      "SUBSCRIPTION_CANCELLATION_SCHEDULED",
      "SUBSCRIPTION_CANCELLED",
      "REFUND_SETTLED_NOTIFICATION",
    ]));
    const accepted: string[] = [];
    const provider: EmailNotificationProvider = {
      async send(_email, idempotencyKey) {
        accepted.push(idempotencyKey);
        return { providerMessageId: `email_${accepted.length}` };
      },
    };
    let acceptedCount = 0;
    let deadLettered = 0;
    for (let batchNumber = 0; batchNumber < 5; batchNumber += 1) {
      const batch = await processEmailOutboxBatch({ now, limit: 25, provider });
      acceptedCount += batch.accepted;
      deadLettered += batch.deadLettered;
      if (batch.scanned === 0) break;
    }

    expect(deadLettered).toBe(0);
    expect(acceptedCount).toBe(pending.length);
    expect(new Set(accepted).size).toBe(pending.length);
    expect(await db.outboxEvent.count({
      where: { id: { in: pending.map((event) => event.id) }, status: { not: "PROCESSED" } },
    })).toBe(0);
  });

  test("snapshot construction reconciles ledgers, requires dual approval, and produces an immutable draw", async () => {
    const { tenant, campaign } = await createPromotion({ closed: true, drawReady: true });
    const operations = await createStaff(tenant.id, "OPERATIONS");
    const compliance = await createStaff(tenant.id, "COMPLIANCE");
    const administrator = await createStaff(tenant.id, "ADMIN");
    await db.campaignPrize.create({
      data: {
        tenantId: tenant.id,
        campaignId: campaign.id,
        name: "Integration winner prize",
        description: "Disposable prize used to verify the post-draw workflow.",
        approximateValueCents: 100_000,
      },
    });
    const eligible = await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, balance: 5n, status: "ELIGIBLE" });
    const secondEligible = await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, balance: 7n, status: "ELIGIBLE" });
    await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, balance: 11n, status: "DISQUALIFIED" });
    await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, balance: 0n, status: "ELIGIBLE" });

    await releasePromotionFixture(campaign.id);
    const built = await buildEntrySnapshot(campaign.id, operations.id);
    expect(built.snapshot).toMatchObject({ status: "AWAITING_APPROVAL", totalEntries: 12n, entrantCount: 2 });
    const rows = await db.entrySnapshotRow.findMany({ where: { snapshotId: built.snapshot.id }, orderBy: { rangeStart: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0].rangeStart).toBe(1n);
    expect(rows[0].rangeEnd + 1n).toBe(rows[1].rangeStart);
    expect(rows[1].rangeEnd).toBe(12n);
    const expectedCsv = `entry_account_id,entrant_id,entry_count,range_start,range_end\n${rows.map((row) => {
      const entrantId = row.entryAccountId === eligible.account.id ? eligible.entrant.id : secondEligible.entrant.id;
      return [row.entryAccountId, entrantId, row.entryCount, row.rangeStart, row.rangeEnd].join(",");
    }).join("\n")}\n`;
    expect(built.canonicalCsv).toBe(expectedCsv);
    expect(built.snapshot.checksum).toBe(createHash("sha256").update(expectedCsv).digest("hex"));
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("SNAPSHOT_REVIEW");
    await expect(conductDemoDraw(built.snapshot.id, operations.id, 2)).rejects.toThrow(/sealed snapshot/i);

    const firstApproval = await approveEntrySnapshot({
      snapshotId: built.snapshot.id,
      actorId: operations.id,
      kind: "OPERATIONS_RECONCILIATION",
      notes: "Ledger and queue reconciliation complete.",
    });
    expect(firstApproval).toMatchObject({ sealed: false, idempotent: false });
    await expect(approveEntrySnapshot({
      snapshotId: built.snapshot.id,
      actorId: operations.id,
      kind: "COMPLIANCE_WITNESS",
      notes: "Attempted self approval.",
    })).rejects.toThrow(/not authorized|different people/i);
    const secondApproval = await approveEntrySnapshot({
      snapshotId: built.snapshot.id,
      actorId: compliance.id,
      kind: "COMPLIANCE_WITNESS",
      notes: "Independent compliance witness approved.",
    });
    expect(secondApproval).toMatchObject({ sealed: true, idempotent: false });
    const sealed = await db.entrySnapshot.findUniqueOrThrow({
      where: { id: built.snapshot.id },
      include: { approvals: true },
    });
    expect(sealed.status).toBe("SEALED");
    expect(sealed.sealedAt).not.toBeNull();
    expect(new Set(sealed.approvals.map((item) => item.approverId))).toEqual(new Set([operations.id, compliance.id]));
    await expect(db.entrySnapshotRow.update({ where: { id: rows[0].id }, data: { entryCount: 99n } }))
      .rejects.toThrow();
    await expect(db.entrySnapshotRow.delete({ where: { id: rows[0].id } })).rejects.toThrow();
    await expect(db.entryLedgerEvent.create({
      data: {
        tenantId: tenant.id,
        entryAccountId: eligible.account.id,
        kind: "GRANT",
        delta: 1n,
        idempotencyKey: `post-seal:${randomUUID()}`,
        effectiveAt: new Date(),
        reasonCode: "POST_SEAL_TEST",
      },
    })).rejects.toThrow();

    const demoMode = process.env.DEMO_MODE;
    process.env.DEMO_MODE = "false";
    await expect(conductDemoDraw(sealed.id, operations.id, 2)).rejects.toThrow(/disabled outside demo mode/i);
    process.env.DEMO_MODE = demoMode;
    const draw = await conductDemoDraw(sealed.id, operations.id, 5);
    expect(draw).toMatchObject({
      status: "VERIFYING",
      operatorId: operations.id,
      witnessId: compliance.id,
      algorithm: "HMAC_SHA256_COUNTER_REJECTION_V1",
    });
    expect(draw.seedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(draw.resultChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(draw.encryptedSeed?.split(".")).toHaveLength(3);
    expect(draw.candidates).toHaveLength(2);
    expect(new Set(draw.candidates.map((candidate) => candidate.entryAccountId)).size).toBe(2);
    for (const candidate of draw.candidates) {
      const row = rows.find((item) => item.entryAccountId === candidate.entryAccountId)!;
      expect(candidate.selectedEntry >= row.rangeStart && candidate.selectedEntry <= row.rangeEnd).toBe(true);
    }
    await expect(conductDemoDraw(sealed.id, operations.id, 2)).rejects.toThrow(/already has a draw/i);

    const [firstCandidate, alternate] = draw.candidates;
    await recordCandidateContact({
      tenantId: tenant.id,
      candidateId: firstCandidate.id,
      actorId: operations.id,
      contactDeadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    await expect(decideDrawCandidate({
      tenantId: tenant.id,
      candidateId: alternate.id,
      actorId: compliance.id,
      decision: "VERIFY",
      reason: "Alternate cannot skip the unresolved first-ranked candidate.",
    })).rejects.toThrow(/earlier-ranked candidate must be resolved/i);
    const disqualified = await decideDrawCandidate({
      tenantId: tenant.id,
      candidateId: firstCandidate.id,
      actorId: compliance.id,
      decision: "DISQUALIFY",
      reason: "The first-ranked candidate did not satisfy documented verification requirements.",
    });
    expect(disqualified).toMatchObject({ candidate: { status: "DISQUALIFIED" }, winner: null, idempotent: false });
    await recordCandidateContact({
      tenantId: tenant.id,
      candidateId: alternate.id,
      actorId: operations.id,
      contactDeadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    const verifiedWinner = await decideDrawCandidate({
      tenantId: tenant.id,
      candidateId: alternate.id,
      actorId: compliance.id,
      decision: "VERIFY",
      reason: "Identity, residency, age, and campaign eligibility were independently verified.",
    });
    expect(verifiedWinner).toMatchObject({ candidate: { status: "VERIFIED" }, winner: { status: "VERIFIED" }, idempotent: false });
    const published = await publishVerifiedWinner({
      tenantId: tenant.id,
      winnerId: verifiedWinner.winner!.id,
      actorId: administrator.id,
      publicName: "Integration Winner",
      publicLocation: "Denver, CO",
      quote: "The documented alternate process worked exactly as disclosed.",
      publicationConsentConfirmed: true,
    });
    expect(published).toMatchObject({
      winner: {
        status: "PUBLISHED",
        publicName: "Integration Winner",
        publicLocation: "Denver, CO",
      },
      idempotent: false,
    });
    const fulfillment = await recordWinnerFulfillment({
      tenantId: tenant.id,
      winnerId: verifiedWinner.winner!.id,
      actorId: operations.id,
      evidenceReference: "evidence://integration/prize-delivery-receipt",
    });
    expect(fulfillment.winner.fulfilledAt).not.toBeNull();
    expect(await db.draw.findUniqueOrThrow({ where: { id: draw.id } })).toMatchObject({ status: "COMPLETED" });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ status: "COMPLETED" });
    const finalWinner = await db.winner.findUniqueOrThrow({ where: { id: verifiedWinner.winner!.id } });
    expect(finalWinner).toMatchObject({ status: "PUBLISHED", publicName: "Integration Winner", publicLocation: "Denver, CO" });
    expect(finalWinner.publishedAt).not.toBeNull();
    expect(finalWinner.fulfilledAt).not.toBeNull();
    const winnerActions = await db.auditEvent.findMany({
      where: { tenantId: tenant.id, resourceId: { in: [firstCandidate.id, alternate.id, finalWinner.id] } },
      select: { action: true, metadataJson: true },
    });
    expect(winnerActions.map((event) => event.action)).toEqual(expect.arrayContaining([
      "DRAW_CANDIDATE_CONTACT_RECORDED",
      "DRAW_CANDIDATE_DISQUALIFIED",
      "DRAW_CANDIDATE_VERIFIED",
      "WINNER_PUBLISHED_WITH_CONSENT",
      "WINNER_FULFILLMENT_RECORDED",
    ]));
    expect(winnerActions.some((event) => event.metadataJson.includes("evidence://integration/prize-delivery-receipt"))).toBe(true);
  });

  test("a provider-confirmed refund is recorded and queued after a dual-approved snapshot is sealed", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 10, drawReady: true });
    const operations = await createStaff(tenant.id, "OPERATIONS");
    const compliance = await createStaff(tenant.id, "COMPLIANCE");
    const product = await createProduct({ tenantId: tenant.id, priceCents: 10_000 });
    const checkout = await completeDemoCheckout(checkoutInput({
      email: "sealed-refund@example.test",
      lines: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1 }],
    }), tenant.slug);
    const order = await db.order.findFirstOrThrow({ where: { orderNumber: checkout.orderNumber, tenantId: tenant.id } });
    await db.campaign.update({
      where: { id: campaign.id },
      data: {
        status: "ENTRY_CLOSED",
        endsAt: new Date(Date.now() - 2_000),
        freeEntryEndsAt: new Date(Date.now() - 2_000),
      },
    });
    await releasePromotionFixture(campaign.id);
    const built = await buildEntrySnapshot(campaign.id, operations.id);
    await approveEntrySnapshot({
      snapshotId: built.snapshot.id,
      actorId: operations.id,
      kind: "OPERATIONS_RECONCILIATION",
      notes: "Refund queue reconciled and complete.",
    });
    await approveEntrySnapshot({
      snapshotId: built.snapshot.id,
      actorId: compliance.id,
      kind: "COMPLIANCE_WITNESS",
      notes: "Compliance witness confirms the snapshot.",
    });
    const balanceBefore = (await db.entryAccount.findFirstOrThrow({ where: { campaignId: campaign.id } })).balance;

    const idempotencyKey = `sealed-refund:${randomUUID()}`;
    const refund = await settleDemoRefund({
      orderId: order.id,
      amountCents: 10_000,
      reason: "Should route to post-seal case",
      actorId: operations.id,
      idempotencyKey,
    });
    const replay = await settleDemoRefund({
      orderId: order.id,
      amountCents: 10_000,
      reason: "Should route to post-seal case",
      actorId: operations.id,
      idempotencyKey,
    });
    expect(replay.id).toBe(refund.id);
    expect(await db.refund.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db.entryAdjustmentRequest.findUniqueOrThrow({ where: { refundId: refund.id } }))
      .toMatchObject({ tenantId: tenant.id, campaignId: campaign.id, status: "PENDING", delta: -1_000n });
    expect((await db.entryAccount.findFirstOrThrow({ where: { campaignId: campaign.id } })).balance).toBe(balanceBefore);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe("REFUNDED");
    expect((await db.payment.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe("REFUNDED");
  });
});
