import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@/server/db";
import { DEFAULT_TENANT_SLUG } from "@/server/storefront";
import { hashRateLimitIdentifier } from "@/server/security/rate-limit-core";
import { normalizeEligibilityLocation } from "@/server/campaigns/eligibility";
import {
  getStripeHostedCheckoutBoundary,
  retrieveStripeCheckoutSessionState,
  type StripeCheckoutSessionState,
  type StripeHostedCheckoutBoundary,
} from "@/server/providers/stripe/hosted-checkout";
import {
  createCheckoutFingerprint,
  type CheckoutFingerprintFacts,
  type PreparedStripeCheckoutRequest,
} from "@/server/providers/stripe/checkout-contract";
import {
  assertOrdinaryCheckoutProductTypes,
  checkoutInputSchema,
  loadAuthoritativeCheckoutQuote,
  type AuthenticatedEntrantIdentity,
  type CheckoutInput,
} from "./checkout";
import {
  createCheckoutReceiptToken,
  hashCheckoutReceiptToken,
  isCheckoutReceiptToken,
} from "./receipt";
import { createOrderNumber } from "./order-number";

const CHECKOUT_SESSION_TTL_MS = 35 * 60 * 1000;
const LOCAL_EXPIRY_GRACE_MS = 15 * 60 * 1000;
const databaseId = z.string().trim().min(1).max(191);
const providerId = z.string().trim().min(1).max(255);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.union([z.date(), z.string().trim().min(1).pipe(z.coerce.date())]);

export const settleStripeCheckoutCaptureSchema = z.object({
  tenantId: databaseId,
  orderId: databaseId,
  providerCheckoutId: providerId,
  providerPaymentId: providerId,
  providerEventId: providerId,
  orderFingerprint: sha256Hex,
  capturedAmountCents: z.number().int().positive().safe(),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  occurredAt: instant,
  payloadHash: sha256Hex,
  idempotencyKey: z.string().trim().min(8).max(255),
}).strict();

export const cancelStripeCheckoutSchema = z.object({
  tenantId: databaseId,
  orderId: databaseId,
  providerCheckoutId: providerId,
  orderFingerprint: sha256Hex,
  occurredAt: instant,
  reason: z.enum(["SESSION_EXPIRED", "ASYNC_PAYMENT_FAILED"]),
  idempotencyKey: z.string().trim().min(8).max(255),
}).strict();

type PreparedOrderRecord = Awaited<ReturnType<typeof findPreparedOrder>>;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalAddress(input: CheckoutInput) {
  const location = normalizeEligibilityLocation(input.country, input.region);
  return JSON.stringify({
    address1: input.address1,
    address2: input.address2 || undefined,
    city: input.city,
    region: location.region,
    postalCode: input.postalCode,
    country: location.country,
    phone: input.phone,
  });
}

function customerFingerprint(input: {
  email: string;
  customerName: string;
  shippingAddressJson: string;
}) {
  return sha256(JSON.stringify({
    email: input.email.toLowerCase(),
    customerName: input.customerName,
    shippingAddressJson: input.shippingAddressJson,
  }));
}

function quotedEntries(line: { entries: bigint; entryCalculationJson: string }) {
  const calculation = JSON.parse(line.entryCalculationJson) as { quotedAfterEntrantCap?: unknown };
  if (typeof calculation.quotedAfterEntrantCap !== "string" || !/^\d+$/.test(calculation.quotedAfterEntrantCap)) {
    throw new Error("Prepared Stripe order line is missing its quoted entry snapshot");
  }
  return calculation.quotedAfterEntrantCap;
}

function fingerprintFacts(order: {
  id: string;
  tenantId: string;
  campaignId: string | null;
  orderNumber: string;
  currency: string;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  email: string;
  customerName: string;
  shippingAddressJson: string;
  receiptTokenHash: string | null;
  checkoutExpiresAt: Date | null;
  lines: Array<{
    id: string;
    productId: string;
    variantId: string | null;
    productTitle: string;
    variantTitle: string | null;
    sku: string | null;
    quantity: number;
    unitPriceCents: number;
    discountCents: number;
    qualifyingCents: number;
    entries: bigint;
    entryCalculationJson: string;
  }>;
}): CheckoutFingerprintFacts {
  if (!order.campaignId || !order.receiptTokenHash || !order.checkoutExpiresAt) {
    throw new Error("Prepared Stripe order is missing immutable checkout facts");
  }
  return {
    tenantId: order.tenantId,
    campaignId: order.campaignId,
    orderId: order.id,
    orderNumber: order.orderNumber,
    currency: order.currency,
    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    shippingCents: order.shippingCents,
    taxCents: order.taxCents,
    totalCents: order.totalCents,
    customerFingerprint: customerFingerprint(order),
    receiptTokenHash: order.receiptTokenHash,
    checkoutExpiresAt: order.checkoutExpiresAt.toISOString(),
    lines: order.lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      variantId: line.variantId,
      productTitle: line.productTitle,
      variantTitle: line.variantTitle,
      sku: line.sku,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      discountCents: line.discountCents,
      qualifyingCents: line.qualifyingCents,
      quotedEntries: quotedEntries(line),
      calculationJson: line.entryCalculationJson,
    })),
  };
}

function assertFingerprint(order: NonNullable<PreparedOrderRecord>) {
  const fingerprint = createCheckoutFingerprint(fingerprintFacts(order));
  if (!order.checkoutFingerprint || order.checkoutFingerprint !== fingerprint) {
    throw new Error("Prepared Stripe order fingerprint does not match persisted facts");
  }
  return fingerprint;
}

function normalizedCartIdentity(lines: CheckoutInput["lines"]) {
  const combined = new Map<string, number>();
  for (const line of lines) {
    const key = `${line.productId}:${line.variantId}`;
    combined.set(key, (combined.get(key) ?? 0) + line.quantity);
  }
  return [...combined.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function assertIdempotentRequest(order: NonNullable<PreparedOrderRecord>, input: CheckoutInput) {
  if (
    order.provider !== "STRIPE"
    || order.email !== input.email.toLowerCase()
    || order.customerName !== input.name
    || order.shippingAddressJson !== canonicalAddress(input)
  ) {
    throw new Error("Checkout idempotency key was already used for different customer details");
  }
  const persisted = order.lines
    .map((line) => [`${line.productId}:${line.variantId}`, line.quantity] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(persisted) !== JSON.stringify(normalizedCartIdentity(input.lines))) {
    throw new Error("Checkout idempotency key was already used for a different cart");
  }
  assertFingerprint(order);
}

async function findPreparedOrder(tenantId: string, idempotencyKey: string) {
  return db.order.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
    include: { lines: { orderBy: { id: "asc" } } },
  });
}

function receiptForOrder(order: { tenantId: string; id: string; idempotencyKey: string }) {
  return createCheckoutReceiptToken({
    tenantId: order.tenantId,
    orderId: order.id,
    idempotencyKey: order.idempotencyKey,
  });
}

async function prepareStripeOrder(
  rawInput: CheckoutInput,
  tenantSlug: string,
  authenticatedIdentity?: AuthenticatedEntrantIdentity,
) {
  const input = checkoutInputSchema.parse(rawInput);
  const tenant = await db.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant || tenant.status !== "ACTIVE") throw new Error("Store is unavailable");
  await assertOrdinaryCheckoutProductTypes(tenant.id, input.lines);

  const prior = await findPreparedOrder(tenant.id, input.idempotencyKey);
  if (prior) {
    assertIdempotentRequest(prior, input);
    if (authenticatedIdentity && (
      prior.tenantId !== authenticatedIdentity.tenantId
      || prior.userId !== authenticatedIdentity.userId
      || prior.entrantId !== authenticatedIdentity.entrantId
    )) {
      throw new Error("Checkout idempotency key was already used for a different account");
    }
    const receipt = receiptForOrder(prior);
    if (prior.receiptTokenHash !== hashCheckoutReceiptToken(receipt)) {
      throw new Error("Prepared Stripe receipt token does not match the order");
    }
    if (prior.paymentStatus === "CAPTURED" && prior.status === "CONFIRMED") {
      return { order: prior, receipt, alreadyCaptured: true };
    }
    if (prior.status !== "PENDING" || prior.paymentStatus !== "UNPAID") {
      throw new Error("This checkout is no longer payable; refresh the page to start again");
    }
    if (!prior.checkoutExpiresAt || prior.checkoutExpiresAt <= new Date()) {
      throw new Error("This checkout has expired; refresh the page to start again");
    }
    return { order: prior, receipt, alreadyCaptured: false };
  }

  const quote = await loadAuthoritativeCheckoutQuote(input, tenantSlug);
  const checkoutExpiresAt = new Date(quote.now.getTime() + CHECKOUT_SESSION_TTL_MS);
  if (checkoutExpiresAt >= quote.campaign.endsAt) {
    throw new Error("Hosted checkout is unavailable this close to the promotion deadline");
  }
  const orderId = randomUUID();
  const generatedOrderNumber = createOrderNumber();
  const receipt = createCheckoutReceiptToken({
    tenantId: tenant.id,
    orderId,
    idempotencyKey: input.idempotencyKey,
  });
  const receiptTokenHash = hashCheckoutReceiptToken(receipt);
  const shippingAddressJson = JSON.stringify(quote.shippingAddress);

  const created = await db.$transaction(async (tx) => {
    let entrant = authenticatedIdentity
      ? await tx.entrant.findFirst({
          where: {
            id: authenticatedIdentity.entrantId,
            tenantId: tenant.id,
            userId: authenticatedIdentity.userId,
            normalizedEmail: quote.normalizedEmail,
          },
        })
      : await tx.entrant.findFirst({
          where: { tenantId: tenant.id, normalizedEmail: quote.normalizedEmail },
          orderBy: { createdAt: "asc" },
        });
    if (authenticatedIdentity && !entrant) throw new Error("Verified account identity does not match checkout");
    if (!entrant) {
      entrant = await tx.entrant.create({
        data: {
          tenantId: tenant.id,
          normalizedEmail: quote.normalizedEmail,
          emailHash: sha256(quote.normalizedEmail),
          name: input.name,
          phone: input.phone,
          region: quote.eligibleLocation.normalizedRegion,
          postalCode: input.postalCode,
          country: quote.eligibleLocation.normalizedCountry,
          eligibilityAttested: true,
        },
      });
    } else if (authenticatedIdentity || !entrant.userId) {
      entrant = await tx.entrant.update({
        where: { id: entrant.id },
        data: {
          name: input.name,
          phone: input.phone,
          region: quote.eligibleLocation.normalizedRegion,
          postalCode: input.postalCode,
          country: quote.eligibleLocation.normalizedCountry,
          eligibilityAttested: true,
        },
      });
    }
    const existingCampaignEntrant = await tx.campaignEntrant.findUnique({
      where: {
        campaignId_entrantId: {
          campaignId: quote.campaign.id,
          entrantId: entrant.id,
        },
      },
    });
    if (existingCampaignEntrant && existingCampaignEntrant.status !== "ELIGIBLE") {
      throw new Error("This entrant is not eligible for the promotion");
    }
    if (!existingCampaignEntrant) {
      await tx.campaignEntrant.create({
        data: {
          campaignId: quote.campaign.id,
          entrantId: entrant.id,
          status: "ELIGIBLE",
          eligibilityJson: JSON.stringify({
            ageConfirmed: true,
            minimumAge: quote.campaign.minimumAge,
            residenceConfirmed: true,
            country: quote.eligibleLocation.normalizedCountry,
            region: quote.eligibleLocation.normalizedRegion,
          }),
        },
      });
    }
    const account = await tx.entryAccount.upsert({
      where: {
        campaignId_entrantId: {
          campaignId: quote.campaign.id,
          entrantId: entrant.id,
        },
      },
      update: {},
      create: {
        tenantId: tenant.id,
        campaignId: quote.campaign.id,
        entrantId: entrant.id,
      },
    });

    let remaining = quote.campaign.maxEntriesPerEntrant == null
      ? null
      : quote.campaign.maxEntriesPerEntrant > account.balance
        ? quote.campaign.maxEntriesPerEntrant - account.balance
        : 0n;
    const lines = quote.quotedLines.map((quoted) => {
      const entries = remaining == null
        ? quoted.calculation.finalEntries
        : quoted.calculation.finalEntries < remaining
          ? quoted.calculation.finalEntries
          : remaining;
      if (remaining != null) remaining -= entries;
      const id = randomUUID();
      const calculationJson = JSON.stringify({
        ...quoted.calculation.snapshot,
        campaignConfigHash: quote.campaign.configChecksum,
        officialRulesDocumentId: quote.officialRules.id,
        officialRulesChecksum: quote.officialRules.checksum,
        multiplierResolution: quote.multiplierResolution.snapshot,
        purchaseRuleResolution: quoted.ruleResolution.snapshot,
        quotedAfterEntrantCap: entries.toString(),
      });
      return { id, quoted, entries, calculationJson };
    });
    const quotedEntryTotal = lines.reduce((sum, line) => sum + line.entries, 0n);

    for (const line of lines) {
      if (line.quoted.product.productType !== "PHYSICAL") continue;
      const reservation = await tx.productVariant.updateMany({
        where: {
          id: line.quoted.variant.id,
          status: "ACTIVE",
          inventory: line.quoted.variant.inventory,
          reservedInventory: line.quoted.variant.reservedInventory,
        },
        data: { reservedInventory: { increment: line.quoted.line.quantity } },
      });
      if (reservation.count !== 1) {
        throw new Error(`${line.quoted.product.title} inventory changed; try again`);
      }
    }

    const hasPhysical = lines.some((line) => line.quoted.product.productType === "PHYSICAL");
    const totalCents = quote.subtotalCents + quote.shippingCents + quote.taxCents;
    const orderForFingerprint = {
      id: orderId,
      tenantId: tenant.id,
      campaignId: quote.campaign.id,
      orderNumber: generatedOrderNumber,
      currency: tenant.currency,
      subtotalCents: quote.subtotalCents,
      discountCents: 0,
      shippingCents: quote.shippingCents,
      taxCents: quote.taxCents,
      totalCents,
      email: quote.normalizedEmail,
      customerName: input.name,
      shippingAddressJson,
      receiptTokenHash,
      checkoutExpiresAt,
      lines: lines.map((line) => ({
        id: line.id,
        productId: line.quoted.product.id,
        variantId: line.quoted.variant.id,
        productTitle: line.quoted.product.title,
        variantTitle: line.quoted.variant.title,
        sku: line.quoted.variant.sku,
        quantity: line.quoted.line.quantity,
        unitPriceCents: line.quoted.unitPriceCents,
        discountCents: 0,
        qualifyingCents: line.quoted.calculation.qualifyingCents,
        entries: line.entries,
        entryCalculationJson: line.calculationJson,
      })),
    };
    const checkoutFingerprint = createCheckoutFingerprint(fingerprintFacts(orderForFingerprint));
    const order = await tx.order.create({
      data: {
        id: orderId,
        tenantId: tenant.id,
        campaignId: quote.campaign.id,
        entrantId: entrant.id,
        userId: entrant.userId,
        orderNumber: generatedOrderNumber,
        channel: "WEB",
        status: "PENDING",
        paymentStatus: "UNPAID",
        fulfillmentStatus: "UNFULFILLED",
        email: quote.normalizedEmail,
        customerName: input.name,
        currency: tenant.currency,
        subtotalCents: quote.subtotalCents,
        shippingCents: quote.shippingCents,
        taxCents: quote.taxCents,
        totalCents,
        entryTotal: quotedEntryTotal,
        shippingAddressJson,
        provider: "STRIPE",
        idempotencyKey: input.idempotencyKey,
        checkoutFingerprint,
        receiptTokenHash,
        checkoutExpiresAt,
        inventoryReservationStatus: hasPhysical ? "HELD" : "NONE",
        lines: {
          create: orderForFingerprint.lines.map((line) => ({
            id: line.id,
            productId: line.productId,
            variantId: line.variantId,
            productTitle: line.productTitle,
            variantTitle: line.variantTitle,
            sku: line.sku,
            quantity: line.quantity,
            unitPriceCents: line.unitPriceCents,
            discountCents: line.discountCents,
            qualifyingCents: line.qualifyingCents,
            entryMultiplier: lines.find((candidate) => candidate.id === line.id)!.quoted.ruleResolution.effectiveMultiplier,
            entries: line.entries,
            entryCalculationJson: line.entryCalculationJson,
          })),
        },
      },
      include: { lines: { orderBy: { id: "asc" } } },
    });

    const persistedOfficialRules = await tx.legalDocument.findFirst({
      where: {
        id: quote.officialRules.id,
        tenantId: tenant.id,
        kind: "OFFICIAL_RULES",
        status: "PUBLISHED",
        version: quote.campaign.rulesVersion,
        checksum: quote.officialRules.checksum,
      },
    });
    if (!persistedOfficialRules) throw new Error("The campaign's exact published Official Rules are unavailable");
    await tx.rulesAcceptance.upsert({
      where: {
        campaignId_entrantId_legalDocumentId_method: {
          campaignId: quote.campaign.id,
          entrantId: entrant.id,
          legalDocumentId: persistedOfficialRules.id,
          method: "CHECKOUT",
        },
      },
      update: {},
      create: {
        tenantId: tenant.id,
        campaignId: quote.campaign.id,
        entrantId: entrant.id,
        legalDocumentId: persistedOfficialRules.id,
        documentChecksum: persistedOfficialRules.checksum,
        method: "CHECKOUT",
      },
    });
    if (input.marketingConsent) {
      await tx.consentEvent.create({
        data: {
          tenantId: tenant.id,
          subjectHash: hashRateLimitIdentifier("consent:newsletter", quote.normalizedEmail),
          channel: "EMAIL",
          action: "GRANTED",
          policyVersion: "checkout-v1",
          disclosure: "Send me product news and future promotion updates. Consent is optional and does not affect entry or odds.",
          source: "CHECKOUT",
        },
      });
      await tx.newsletterSubscriber.upsert({
        where: {
          tenantId_normalizedEmail: {
            tenantId: tenant.id,
            normalizedEmail: quote.normalizedEmail,
          },
        },
        update: { status: "SUBSCRIBED", unsubscribedAt: null },
        create: {
          tenantId: tenant.id,
          email: quote.normalizedEmail,
          normalizedEmail: quote.normalizedEmail,
          source: "CHECKOUT",
          consentText: "Optional email product news and promotion updates.",
        },
      });
    }
    await tx.auditEvent.create({
      data: {
        tenantId: tenant.id,
        actorType: "CUSTOMER",
        actorId: entrant.id,
        action: "STRIPE_ORDER_PREPARED",
        resourceType: "Order",
        resourceId: order.id,
        metadataJson: JSON.stringify({
          orderNumber: order.orderNumber,
          checkoutFingerprint,
          expiresAt: checkoutExpiresAt.toISOString(),
        }),
      },
    });
    return order;
  });

  return { order: created, receipt, alreadyCaptured: false };
}

function canonicalAppUrl() {
  const configured = process.env.APP_URL?.trim();
  if (!configured) throw new Error("APP_URL must be configured before hosted checkout");
  const url = new URL(configured);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("APP_URL must use HTTPS in production");
  }
  if (!url.origin || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("APP_URL must be an absolute HTTP(S) origin");
  }
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("APP_URL must contain only the canonical application origin");
  }
  return url;
}

function checkoutRequestFromOrder(
  order: NonNullable<PreparedOrderRecord>,
  receipt: string,
): PreparedStripeCheckoutRequest {
  const fingerprint = assertFingerprint(order);
  if (!order.checkoutExpiresAt) throw new Error("Prepared Stripe order has no expiration");
  const appUrl = canonicalAppUrl();
  const successUrl = new URL("/checkout/success", appUrl);
  successUrl.searchParams.set("receipt", receipt);
  const cancelUrl = new URL("/checkout", appUrl);
  cancelUrl.searchParams.set("cancelled", "1");
  return {
    tenantId: order.tenantId,
    orderId: order.id,
    orderNumber: order.orderNumber,
    orderFingerprint: fingerprint,
    customerEmail: order.email,
    expectedAmountCents: order.totalCents,
    currency: order.currency,
    shippingCents: order.shippingCents,
    taxCents: order.taxCents,
    expiresAt: order.checkoutExpiresAt,
    successUrl: successUrl.toString(),
    cancelUrl: cancelUrl.toString(),
    idempotencyKey: `stripe-checkout:${sha256(`${order.tenantId}:${order.id}:${fingerprint}`)}`,
    lines: order.lines.map((line) => ({
      productTitle: line.productTitle,
      variantTitle: line.variantTitle,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      discountCents: line.discountCents,
    })),
  };
}

export async function startStripeCheckout(
  rawInput: CheckoutInput,
  tenantSlug = DEFAULT_TENANT_SLUG,
  boundary: StripeHostedCheckoutBoundary = getStripeHostedCheckoutBoundary(),
) {
  const prepared = await prepareStripeOrder(rawInput, tenantSlug);
  const localSuccessUrl = new URL("/checkout/success", canonicalAppUrl());
  localSuccessUrl.searchParams.set("receipt", prepared.receipt);
  if (prepared.alreadyCaptured) {
    return { redirectUrl: localSuccessUrl.toString(), receipt: prepared.receipt };
  }

  const request = checkoutRequestFromOrder(prepared.order, prepared.receipt);
  const hosted = await boundary.createForPreparedOrder(request);
  const bound = await db.order.updateMany({
    where: {
      id: prepared.order.id,
      tenantId: prepared.order.tenantId,
      checkoutFingerprint: request.orderFingerprint,
      status: "PENDING",
      paymentStatus: "UNPAID",
      OR: [
        { providerCheckoutId: null },
        { providerCheckoutId: hosted.providerCheckoutId },
      ],
    },
    data: { providerCheckoutId: hosted.providerCheckoutId },
  });
  if (bound.count !== 1) {
    throw new Error("Stripe checkout session conflicts with the prepared order");
  }
  return {
    redirectUrl: hosted.redirectUrl,
    providerCheckoutId: hosted.providerCheckoutId,
    receipt: prepared.receipt,
  };
}

export async function startStripeCheckoutForViewer(
  rawInput: CheckoutInput,
  tenantSlug: string,
  authenticatedIdentity: AuthenticatedEntrantIdentity,
  boundary: StripeHostedCheckoutBoundary = getStripeHostedCheckoutBoundary(),
) {
  const prepared = await prepareStripeOrder(rawInput, tenantSlug, authenticatedIdentity);
  const localSuccessUrl = new URL("/checkout/success", canonicalAppUrl());
  localSuccessUrl.searchParams.set("receipt", prepared.receipt);
  if (prepared.alreadyCaptured) {
    return { redirectUrl: localSuccessUrl.toString(), receipt: prepared.receipt };
  }
  const request = checkoutRequestFromOrder(prepared.order, prepared.receipt);
  const hosted = await boundary.createForPreparedOrder(request);
  const bound = await db.order.updateMany({
    where: {
      id: prepared.order.id,
      tenantId: prepared.order.tenantId,
      checkoutFingerprint: request.orderFingerprint,
      status: "PENDING",
      paymentStatus: "UNPAID",
      OR: [{ providerCheckoutId: null }, { providerCheckoutId: hosted.providerCheckoutId }],
    },
    data: { providerCheckoutId: hosted.providerCheckoutId },
  });
  if (bound.count !== 1) throw new Error("Stripe checkout session conflicts with the prepared order");
  return {
    redirectUrl: hosted.redirectUrl,
    providerCheckoutId: hosted.providerCheckoutId,
    receipt: prepared.receipt,
  };
}

async function existingCapture(input: z.infer<typeof settleStripeCheckoutCaptureSchema>) {
  return db.payment.findUnique({
    where: { provider_providerEventId: { provider: "STRIPE", providerEventId: input.providerEventId } },
    include: { order: true },
  });
}

function assertMatchingCapture(
  payment: NonNullable<Awaited<ReturnType<typeof existingCapture>>>,
  input: z.infer<typeof settleStripeCheckoutCaptureSchema>,
) {
  if (
    payment.orderId !== input.orderId
    || payment.providerPaymentId !== input.providerPaymentId
    || payment.amountCents !== input.capturedAmountCents
    || payment.currency !== input.currency
    || payment.payloadHash !== input.payloadHash
    || payment.status !== "CAPTURED"
    || payment.order.tenantId !== input.tenantId
    || payment.order.providerCheckoutId !== input.providerCheckoutId
    || payment.order.checkoutFingerprint !== input.orderFingerprint
    || payment.order.paymentStatus !== "CAPTURED"
  ) {
    throw new Error("Stripe checkout capture conflicts with an existing payment");
  }
  return {
    orderId: payment.order.id,
    orderNumber: payment.order.orderNumber,
    entries: payment.order.entryTotal,
    receiptStatus: "CAPTURED" as const,
    idempotent: true,
  };
}

function prismaErrorCode(error: unknown) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Canonical one-time capture. Only a verified provider adapter may call this. */
export async function settleStripeCheckoutCapture(rawInput: unknown) {
  const input = settleStripeCheckoutCaptureSchema.parse(rawInput);
  const prior = await existingCapture(input);
  if (prior) return assertMatchingCapture(prior, input);

  try {
    return await db.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: input.orderId, tenantId: input.tenantId },
        include: {
          campaign: true,
          lines: {
            orderBy: { id: "asc" },
            include: { product: true, variant: true },
          },
        },
      });
      if (!order || !order.campaign) throw new Error("Prepared Stripe order not found");
      if (
        order.provider !== "STRIPE"
        || order.providerCheckoutId !== input.providerCheckoutId
        || order.checkoutFingerprint !== input.orderFingerprint
      ) {
        throw new Error("Stripe checkout identity does not match the prepared order");
      }
      if (
        order.totalCents !== input.capturedAmountCents
        || order.currency !== input.currency
      ) {
        throw new Error("Stripe capture amount or currency does not match the prepared order");
      }
      if (order.paymentStatus === "CAPTURED") {
        const captured = await tx.payment.findUnique({
          where: {
            provider_providerEventId: {
              provider: "STRIPE",
              providerEventId: input.providerEventId,
            },
          },
          include: { order: true },
        });
        if (!captured) throw new Error("Captured Stripe order is missing its canonical payment");
        return assertMatchingCapture(captured, input);
      }
      if (order.status !== "PENDING" || order.paymentStatus !== "UNPAID") {
        throw new Error("Prepared Stripe order is not payable");
      }
      if (
        !order.checkoutExpiresAt
        || input.occurredAt > order.checkoutExpiresAt
        || input.occurredAt < order.createdAt
        || input.occurredAt < order.campaign.startsAt
        || input.occurredAt >= order.campaign.endsAt
      ) {
        throw new Error("Stripe capture occurred outside the prepared campaign checkout window");
      }
      if (createCheckoutFingerprint(fingerprintFacts(order)) !== input.orderFingerprint) {
        throw new Error("Persisted Stripe order facts changed after checkout preparation");
      }

      const claimedAt = new Date(Math.max(Date.now(), order.updatedAt.getTime() + 1));
      const claim = await tx.order.updateMany({
        where: {
          id: order.id,
          tenantId: order.tenantId,
          status: "PENDING",
          paymentStatus: "UNPAID",
          updatedAt: order.updatedAt,
          providerCheckoutId: input.providerCheckoutId,
          checkoutFingerprint: input.orderFingerprint,
        },
        data: { updatedAt: claimedAt },
      });
      if (claim.count !== 1) throw new Error("Stripe checkout settlement lost its order claim");

      const campaignEntrant = await tx.campaignEntrant.findUnique({
        where: {
          campaignId_entrantId: {
            campaignId: order.campaignId!,
            entrantId: order.entrantId,
          },
        },
      });
      let entrantEligibleAtCapture = false;
      if (campaignEntrant?.status === "ELIGIBLE") {
        // Treat eligibility as a settlement fact, not merely a checkout-start
        // fact. This CAS serializes a capture with a concurrent compliance
        // decision; a committed disqualification keeps the money/order truth
        // but withholds all promotional entries.
        const eligibilityClaimedAt = new Date(Math.max(
          Date.now(),
          campaignEntrant.updatedAt.getTime() + 1,
        ));
        const eligibilityClaim = await tx.campaignEntrant.updateMany({
          where: {
            id: campaignEntrant.id,
            status: "ELIGIBLE",
            updatedAt: campaignEntrant.updatedAt,
          },
          data: { updatedAt: eligibilityClaimedAt },
        });
        if (eligibilityClaim.count !== 1) {
          throw new Error("Entrant eligibility changed during Stripe settlement; retry the provider event");
        }
        entrantEligibleAtCapture = true;
      }

      const account = await tx.entryAccount.findUnique({
        where: {
          campaignId_entrantId: {
            campaignId: order.campaignId!,
            entrantId: order.entrantId,
          },
        },
      });
      if (!account) throw new Error("Prepared Stripe order entry account is missing");
      let remaining = !entrantEligibleAtCapture
        ? 0n
        : order.campaign.maxEntriesPerEntrant == null
        ? null
        : order.campaign.maxEntriesPerEntrant > account.balance
          ? order.campaign.maxEntriesPerEntrant - account.balance
          : 0n;
      const awardedLines = order.lines.map((line) => {
        const entries = remaining == null
          ? line.entries
          : line.entries < remaining
            ? line.entries
            : remaining;
        if (remaining != null) remaining -= entries;
        return { line, entries };
      });
      const entryTotal = awardedLines.reduce((sum, line) => sum + line.entries, 0n);

      const physicalLines = awardedLines.filter((item) => item.line.product.productType === "PHYSICAL");
      if (physicalLines.length && order.inventoryReservationStatus !== "HELD") {
        throw new Error("Prepared Stripe order has no active inventory reservation");
      }
      for (const { line } of physicalLines) {
        if (!line.variantId || !line.variant) throw new Error("Physical order line is missing its variant");
        const committed = await tx.productVariant.updateMany({
          where: {
            id: line.variantId,
            inventory: { gte: line.quantity },
            reservedInventory: { gte: line.quantity },
          },
          data: {
            inventory: { decrement: line.quantity },
            reservedInventory: { decrement: line.quantity },
          },
        });
        if (committed.count !== 1) {
          throw new Error(`Reserved inventory for ${line.productTitle} is unavailable`);
        }
        await tx.inventoryAdjustment.create({
          data: {
            tenantId: order.tenantId,
            productId: line.productId,
            variantId: line.variantId,
            orderId: order.id,
            delta: -line.quantity,
            reasonCode: "STRIPE_PAYMENT_CAPTURED",
            actorType: "PAYMENT_PROVIDER",
            actorId: "STRIPE",
            idempotencyKey: `stripe-inventory:${input.providerCheckoutId}:${line.id}`,
            metadataJson: JSON.stringify({ orderNumber: order.orderNumber }),
          },
        });
      }

      for (const { line, entries } of awardedLines) {
        const calculation = JSON.parse(line.entryCalculationJson) as Record<string, unknown>;
        const calculationJson = JSON.stringify({
          ...calculation,
          awardedAtCapture: entries.toString(),
          campaignEntrantStatusAtCapture: campaignEntrant?.status ?? "MISSING",
          eligibilityValidatedAtCapture: entrantEligibleAtCapture,
          providerCheckoutId: input.providerCheckoutId,
        });
        await tx.orderLine.update({
          where: { id: line.id },
          data: { entries },
        });
        if (entries <= 0n) continue;
        const entitlement = await tx.entryEntitlement.create({
          data: {
            tenantId: order.tenantId,
            entryAccountId: account.id,
            orderId: order.id,
            orderLineId: line.id,
            originType: "ORDER_LINE",
            status: "POSTED",
            originalEntries: entries,
            calculationJson,
            campaignConfigHash: order.campaign.configChecksum,
            idempotencyKey: `stripe-checkout-entitlement:${input.providerCheckoutId}:${line.id}`,
            effectiveAt: input.occurredAt,
          },
        });
        await tx.entryLedgerEvent.create({
          data: {
            tenantId: order.tenantId,
            entryAccountId: account.id,
            entitlementId: entitlement.id,
            kind: "GRANT",
            delta: entries,
            idempotencyKey: `stripe-checkout-ledger:${input.providerCheckoutId}:${line.id}`,
            effectiveAt: input.occurredAt,
            actorType: "PAYMENT_PROVIDER",
            actorId: "STRIPE",
            reasonCode: "STRIPE_PAYMENT_CAPTURED",
            metadataJson: JSON.stringify({
              orderNumber: order.orderNumber,
              orderLineId: line.id,
              providerCheckoutId: input.providerCheckoutId,
              providerPaymentId: input.providerPaymentId,
            }),
          },
        });
      }

      if (entryTotal > 0n) {
        const accountUpdate = await tx.entryAccount.updateMany({
          where: {
            id: account.id,
            balance: account.balance,
            version: account.version,
          },
          data: {
            balance: { increment: entryTotal },
            version: { increment: 1 },
          },
        });
        if (accountUpdate.count !== 1) {
          throw new Error("Stripe checkout settlement lost its entry-cap claim");
        }
      }
      const payment = await tx.payment.create({
        data: {
          orderId: order.id,
          provider: "STRIPE",
          providerEventId: input.providerEventId,
          providerPaymentId: input.providerPaymentId,
          status: "CAPTURED",
          amountCents: input.capturedAmountCents,
          currency: input.currency,
          payloadHash: input.payloadHash,
          idempotencyKey: input.idempotencyKey,
          processedAt: input.occurredAt,
        },
      });
      const completed = await tx.order.updateMany({
        where: { id: order.id, updatedAt: claimedAt },
        data: {
          status: "CONFIRMED",
          paymentStatus: "CAPTURED",
          fulfillmentStatus: order.lines.every((line) => line.product.productType === "DIGITAL")
            ? "FULFILLED"
            : "UNFULFILLED",
          providerPaymentId: input.providerPaymentId,
          entryTotal,
          inventoryReservationStatus: physicalLines.length ? "COMMITTED" : "NONE",
          paidAt: input.occurredAt,
        },
      });
      if (completed.count !== 1) throw new Error("Stripe checkout settlement lost its completion claim");
      if (!entrantEligibleAtCapture) {
        await tx.auditEvent.create({
          data: {
            tenantId: order.tenantId,
            actorType: "PAYMENT_PROVIDER",
            actorId: "STRIPE",
            action: "STRIPE_ORDER_ENTRIES_WITHHELD",
            resourceType: "Order",
            resourceId: order.id,
            reason: "Entrant was not currently eligible when the verified payment settled",
            metadataJson: JSON.stringify({
              orderNumber: order.orderNumber,
              campaignId: order.campaignId,
              campaignEntrantStatus: campaignEntrant?.status ?? "MISSING",
              providerCheckoutId: input.providerCheckoutId,
              providerPaymentId: input.providerPaymentId,
            }),
          },
        });
      }
      await tx.auditEvent.create({
        data: {
          tenantId: order.tenantId,
          actorType: "PAYMENT_PROVIDER",
          actorId: "STRIPE",
          action: "STRIPE_ORDER_CAPTURED",
          resourceType: "Order",
          resourceId: order.id,
          metadataJson: JSON.stringify({
            orderNumber: order.orderNumber,
            paymentId: payment.id,
            providerCheckoutId: input.providerCheckoutId,
            providerPaymentId: input.providerPaymentId,
            entries: entryTotal.toString(),
            eligibilityValidatedAtCapture: entrantEligibleAtCapture,
            campaignEntrantStatusAtCapture: campaignEntrant?.status ?? "MISSING",
          }),
        },
      });
      await tx.outboxEvent.createMany({
        data: [
          {
            tenantId: order.tenantId,
            aggregateType: "Order",
            aggregateId: order.id,
            kind: "ORDER_CONFIRMATION_EMAIL",
            payloadJson: JSON.stringify({ orderId: order.id }),
            idempotencyKey: `order-confirmation:${order.id}`,
          },
          {
            tenantId: order.tenantId,
            aggregateType: "Order",
            aggregateId: order.id,
            kind: "FULFILLMENT_SUBMISSION",
            payloadJson: JSON.stringify({ orderId: order.id }),
            idempotencyKey: `fulfillment:${order.id}`,
          },
        ],
      });
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        entries: entryTotal,
        receiptStatus: "CAPTURED" as const,
        idempotent: false,
      };
    });
  } catch (error) {
    if (prismaErrorCode(error) !== "P2002") throw error;
    const raced = await existingCapture(input);
    if (!raced) throw error;
    return assertMatchingCapture(raced, input);
  }
}

async function cancelPreparedOrder(input: {
  tenantId: string;
  orderId: string;
  providerCheckoutId: string | null;
  orderFingerprint: string;
  occurredAt: Date;
  reason: "SESSION_EXPIRED" | "ASYNC_PAYMENT_FAILED" | "LOCAL_EXPIRY";
  idempotencyKey: string;
}) {
  return db.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: input.orderId, tenantId: input.tenantId },
      include: {
        lines: {
          include: { product: true, variant: true },
          orderBy: { id: "asc" },
        },
      },
    });
    if (!order || order.provider !== "STRIPE") throw new Error("Prepared Stripe order not found");
    if (
      order.checkoutFingerprint !== input.orderFingerprint
      || (input.providerCheckoutId && order.providerCheckoutId !== input.providerCheckoutId)
    ) {
      throw new Error("Stripe cancellation identity does not match the prepared order");
    }
    if (order.paymentStatus === "CAPTURED") {
      return { orderId: order.id, status: "CAPTURED", idempotent: true };
    }
    if (order.status === "CANCELLED") {
      return { orderId: order.id, status: "CANCELLED", idempotent: true };
    }
    if (order.status !== "PENDING" || order.paymentStatus !== "UNPAID") {
      throw new Error("Prepared Stripe order cannot be cancelled from its current state");
    }
    const claimedAt = new Date(Math.max(Date.now(), order.updatedAt.getTime() + 1));
    const claim = await tx.order.updateMany({
      where: {
        id: order.id,
        status: "PENDING",
        paymentStatus: "UNPAID",
        updatedAt: order.updatedAt,
      },
      data: { updatedAt: claimedAt },
    });
    if (claim.count !== 1) throw new Error("Stripe cancellation lost its order claim");

    if (order.inventoryReservationStatus === "HELD") {
      for (const line of order.lines) {
        if (line.product.productType !== "PHYSICAL" || !line.variantId) continue;
        const released = await tx.productVariant.updateMany({
          where: { id: line.variantId, reservedInventory: { gte: line.quantity } },
          data: { reservedInventory: { decrement: line.quantity } },
        });
        if (released.count !== 1) {
          throw new Error(`Reserved inventory for ${line.productTitle} cannot be released`);
        }
      }
    }
    await tx.order.update({
      where: { id: order.id },
      data: {
        status: "CANCELLED",
        paymentStatus: input.reason === "ASYNC_PAYMENT_FAILED" ? "FAILED" : "UNPAID",
        inventoryReservationStatus: order.inventoryReservationStatus === "HELD" ? "RELEASED" : "NONE",
        cancelledAt: input.occurredAt,
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: order.tenantId,
        actorType: input.reason === "LOCAL_EXPIRY" ? "SYSTEM" : "PAYMENT_PROVIDER",
        actorId: input.reason === "LOCAL_EXPIRY" ? null : "STRIPE",
        action: `STRIPE_CHECKOUT_${input.reason}`,
        resourceType: "Order",
        resourceId: order.id,
        metadataJson: JSON.stringify({
          providerCheckoutId: input.providerCheckoutId,
          requestFingerprint: sha256(input.idempotencyKey),
        }),
      },
    });
    await tx.outboxEvent.create({
      data: {
        tenantId: order.tenantId,
        aggregateType: "Order",
        aggregateId: order.id,
        kind: "CHECKOUT_CANCELLED_NOTIFICATION",
        payloadJson: JSON.stringify({ orderId: order.id, reason: input.reason }),
        idempotencyKey: `checkout-cancelled:${order.id}`,
      },
    });
    return { orderId: order.id, status: "CANCELLED", idempotent: false };
  });
}

export async function cancelStripeCheckout(rawInput: unknown) {
  const input = cancelStripeCheckoutSchema.parse(rawInput);
  return cancelPreparedOrder(input);
}

/** Worker hook for sessions that never produced a provider delivery. */
export async function releaseExpiredStripeCheckoutOrders(
  now = new Date(),
  limit = 100,
  retrieveSession: (
    providerCheckoutId: string,
  ) => Promise<StripeCheckoutSessionState> = retrieveStripeCheckoutSessionState,
) {
  const cutoff = new Date(now.getTime() - LOCAL_EXPIRY_GRACE_MS);
  const expired = await db.order.findMany({
    where: {
      provider: "STRIPE",
      status: "PENDING",
      paymentStatus: "UNPAID",
      checkoutExpiresAt: { lt: cutoff },
    },
    select: {
      id: true,
      tenantId: true,
      providerCheckoutId: true,
      checkoutFingerprint: true,
    },
    orderBy: { checkoutExpiresAt: "asc" },
    take: Math.min(Math.max(limit, 1), 500),
  });
  let released = 0;
  let skipped = 0;
  let failures = 0;
  for (const order of expired) {
    try {
      if (!order.checkoutFingerprint) {
        skipped += 1;
        continue;
      }
      if (order.providerCheckoutId) {
        const providerState = await retrieveSession(order.providerCheckoutId);
        if (providerState.status !== "expired" || providerState.paymentStatus === "paid") {
          skipped += 1;
          continue;
        }
      }
      const result = await cancelPreparedOrder({
        tenantId: order.tenantId,
        orderId: order.id,
        providerCheckoutId: order.providerCheckoutId,
        orderFingerprint: order.checkoutFingerprint,
        occurredAt: now,
        reason: "LOCAL_EXPIRY",
        idempotencyKey: `local-checkout-expiry:${order.id}`,
      });
      if (result.status === "CANCELLED" && !result.idempotent) released += 1;
      else skipped += 1;
    } catch {
      // Provider uncertainty must preserve the hold for the next bounded pass.
      failures += 1;
    }
  }
  return { scanned: expired.length, released, skipped, failures };
}

export async function getCheckoutReceipt(receipt: string, tenantId: string) {
  if (!isCheckoutReceiptToken(receipt)) return null;
  const order = await db.order.findFirst({
    where: {
      tenantId,
      receiptTokenHash: hashCheckoutReceiptToken(receipt),
    },
    select: {
      orderNumber: true,
      provider: true,
      status: true,
      paymentStatus: true,
      totalCents: true,
      currency: true,
      entryTotal: true,
      createdAt: true,
    },
  });
  if (!order) return null;
  return order;
}
