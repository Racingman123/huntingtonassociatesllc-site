import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@/server/db";
import { calculateEntries } from "@/lib/entries";
import { assertCampaignOfficialRules } from "@/lib/official-rules";
import { resolvePurchaseEntryRules } from "@/lib/purchase-entry-rules";
import { phoneSchema } from "@/lib/phone";
import { DEFAULT_TENANT_SLUG } from "@/server/storefront";
import { hashRateLimitIdentifier } from "@/server/security/rate-limit-core";
import { assertCampaignLocationEligible } from "@/server/campaigns/eligibility";
import { inspectCampaignReleaseIntegrity } from "@/server/campaigns/integrity";
import {
  createCheckoutReceiptToken,
  hashCheckoutReceiptToken,
} from "./receipt";
import { createOrderNumber } from "./order-number";
import { resolveConfiguredCampaignMultiplier } from "./multiplier";

export const cartLineInputSchema = z.object({
  productId: z.string().min(1),
  variantId: z.string().min(1),
  quantity: z.number().int().min(1).max(20),
});

export const checkoutInputSchema = z.object({
  email: z.email().trim().toLowerCase(),
  name: z.string().trim().min(2).max(100),
  phone: phoneSchema,
  address1: z.string().trim().min(3).max(120),
  address2: z.string().trim().max(120).optional(),
  city: z.string().trim().min(2).max(80),
  region: z.string().trim().min(2).max(40),
  postalCode: z.string().trim().min(3).max(16),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  ageConfirmed: z.literal(true),
  rulesAccepted: z.literal(true),
  marketingConsent: z.boolean().default(false),
  idempotencyKey: z.string().uuid(),
  lines: z.array(cartLineInputSchema).min(1).max(20),
});

export type CheckoutInput = z.infer<typeof checkoutInputSchema>;

export type AuthenticatedEntrantIdentity = {
  tenantId: string;
  userId: string;
  entrantId: string;
  normalizedEmail: string;
};

function hashValue(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedCartLines(lines: CheckoutInput["lines"]) {
  const combined = new Map<string, CheckoutInput["lines"][number]>();
  for (const line of lines) {
    const key = `${line.productId}:${line.variantId}`;
    const previous = combined.get(key);
    const quantity = (previous?.quantity ?? 0) + line.quantity;
    if (quantity > 20) throw new Error("A cart item cannot have a quantity greater than 20");
    combined.set(key, { ...line, quantity });
  }
  return [...combined.values()].sort((a, b) => (
    `${a.productId}:${a.variantId}`.localeCompare(`${b.productId}:${b.variantId}`)
  ));
}

export async function assertOrdinaryCheckoutProductTypes(
  tenantId: string,
  lines: CheckoutInput["lines"],
) {
  const membershipCount = await db.product.count({
    where: {
      tenantId,
      id: { in: [...new Set(lines.map((line) => line.productId))] },
      productType: "MEMBERSHIP",
    },
  });
  if (membershipCount > 0) {
    throw new Error("Membership products must be purchased through recurring enrollment");
  }
}

async function loadQuoteForTenant(
  input: CheckoutInput,
  tenant: {
    id: string;
    currency: string;
    status: string;
    flatShippingCents: number;
    freeShippingThresholdCents: number;
  },
) {
  if (tenant.status !== "ACTIVE") throw new Error("Store is unavailable");
  const now = new Date();
  const campaigns = await db.campaign.findMany({
    where: {
      tenantId: tenant.id,
      status: "LIVE",
      startsAt: { lte: now },
      endsAt: { gt: now },
    },
    include: {
      multiplierSlots: { orderBy: { startsAt: "asc" } },
      entryRules: { where: { ruleType: "MONEY_RATE", active: true }, orderBy: [{ stackPriority: "asc" }, { id: "asc" }] },
      officialRulesDocument: true,
    },
    orderBy: { startsAt: "desc" },
    take: 2,
  });
  if (campaigns.length === 0) throw new Error("There is no active promotion");
  if (campaigns.length > 1) {
    throw new Error("Multiple active promotions require an explicit campaign selection");
  }
  const campaign = campaigns[0]!;
  if (campaign.approvedAt) {
    const integrity = await inspectCampaignReleaseIntegrity(db, campaign.id);
    if (!integrity.valid) {
      throw new Error("Promotion configuration failed integrity verification");
    }
  }
  const officialRules = assertCampaignOfficialRules(campaign);
  const multiplierResolution = resolveConfiguredCampaignMultiplier({
    currentMultiplier: campaign.currentMultiplier,
    slots: campaign.multiplierSlots,
    at: now,
  });
  const eligibleLocation = assertCampaignLocationEligible(campaign, {
    country: input.country,
    region: input.region,
  });

  const normalizedLines = normalizedCartLines(input.lines);
  const productIds = [...new Set(normalizedLines.map((line) => line.productId))];
  const products = await db.product.findMany({
    where: { tenantId: tenant.id, id: { in: productIds }, status: "ACTIVE" },
    include: {
      variants: { where: { status: "ACTIVE" } },
      collections: { include: { collection: { select: { id: true, slug: true } } } },
    },
  });
  if (products.length !== productIds.length) {
    throw new Error("One or more cart items are no longer available");
  }

  const productsById = new Map(products.map((product) => [product.id, product]));
  const quotedLines = normalizedLines.map((line) => {
    const product = productsById.get(line.productId);
    const variant = product?.variants.find((candidate) => candidate.id === line.variantId);
    if (!product || !variant || variant.productId !== product.id) {
      throw new Error("A selected product option is unavailable");
    }
    if (product.productType === "MEMBERSHIP") {
      throw new Error("Membership products must be purchased through recurring enrollment");
    }
    if (
      product.productType === "PHYSICAL"
      && variant.inventory - variant.reservedInventory < line.quantity
    ) {
      throw new Error(`${product.title} does not have enough inventory`);
    }
    const unitPriceCents = variant.priceCents ?? product.priceCents;
    const ruleResolution = resolvePurchaseEntryRules({
      at: now,
      campaignBaseEntriesPerCurrencyUnit: campaign.baseEntriesPerDollar,
      catalogProductMultiplier: product.entryMultiplier,
      campaignMultiplier: multiplierResolution.factor,
      rules: campaign.entryRules,
      target: {
        productId: product.id,
        productSlug: product.slug,
        category: product.category,
        collectionIds: product.collections.map((membership) => membership.collection.id),
        collectionSlugs: product.collections.map((membership) => membership.collection.slug),
        variantId: variant.id,
        variantSku: variant.sku,
      },
    });
    const calculation = calculateEntries({
      unitPriceCents,
      quantity: line.quantity,
      baseEntriesPerDollar: campaign.baseEntriesPerDollar,
      productMultiplier: product.entryMultiplier,
      purchaseRuleMultiplier: ruleResolution.purchaseRuleMultiplier,
      campaignMultiplier: multiplierResolution.factor,
    });
    return { line, product, variant, unitPriceCents, calculation, ruleResolution };
  });
  const subtotalCents = quotedLines.reduce(
    (total, line) => total + line.unitPriceCents * line.line.quantity,
    0,
  );
  const shippingCents = quotedLines.some((line) => line.product.productType === "PHYSICAL")
    && subtotalCents < tenant.freeShippingThresholdCents
    ? tenant.flatShippingCents
    : 0;
  const taxCents = 0;
  const shippingAddress = {
    address1: input.address1,
    address2: input.address2 || undefined,
    city: input.city,
    region: eligibleLocation.normalizedRegion,
    postalCode: input.postalCode,
    country: eligibleLocation.normalizedCountry,
    phone: input.phone,
  };
  return {
    input,
    tenant,
    campaign,
    now,
    normalizedEmail: input.email.toLowerCase(),
    quotedLines,
    subtotalCents,
    shippingCents,
    taxCents,
    shippingAddress,
    eligibleLocation,
    multiplierResolution,
    officialRules,
  };
}

/** Shared server-authoritative quote used by demo and hosted production checkout. */
export async function loadAuthoritativeCheckoutQuote(
  rawInput: CheckoutInput,
  tenantSlug = DEFAULT_TENANT_SLUG,
) {
  const input = checkoutInputSchema.parse(rawInput);
  const tenant = await db.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) throw new Error("Store is unavailable");
  return loadQuoteForTenant(input, tenant);
}

export async function getResolvedCheckoutCampaignMultiplier(
  campaignId: string,
  currentMultiplier: number,
  at = new Date(),
) {
  const slots = await db.entryMultiplierPeriod.findMany({
    where: { campaignId },
    orderBy: { startsAt: "asc" },
  });
  return resolveConfiguredCampaignMultiplier({ currentMultiplier, slots, at });
}

export async function completeDemoCheckout(
  rawInput: CheckoutInput,
  tenantSlug = DEFAULT_TENANT_SLUG,
  authenticatedIdentity?: AuthenticatedEntrantIdentity,
) {
  const input = checkoutInputSchema.parse(rawInput);
  const tenant = await db.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant || tenant.status !== "ACTIVE") throw new Error("Store is unavailable");
  await assertOrdinaryCheckoutProductTypes(tenant.id, input.lines);

  const priorOrder = await db.order.findUnique({
    where: { tenantId_idempotencyKey: { tenantId: tenant.id, idempotencyKey: input.idempotencyKey } },
  });
  if (priorOrder) {
    if (authenticatedIdentity && (
      priorOrder.tenantId !== authenticatedIdentity.tenantId
      || priorOrder.userId !== authenticatedIdentity.userId
      || priorOrder.entrantId !== authenticatedIdentity.entrantId
    )) {
      throw new Error("Checkout idempotency key was already used for a different account");
    }
    const receipt = createCheckoutReceiptToken({
      tenantId: tenant.id,
      orderId: priorOrder.id,
      idempotencyKey: priorOrder.idempotencyKey,
    });
    if (!priorOrder.receiptTokenHash) {
      await db.order.update({
        where: { id: priorOrder.id },
        data: { receiptTokenHash: hashCheckoutReceiptToken(receipt) },
      });
    }
    return { orderNumber: priorOrder.orderNumber, receipt, entries: priorOrder.entryTotal };
  }
  const quote = await loadQuoteForTenant(input, tenant);
  const {
    campaign,
    now,
    quotedLines,
    subtotalCents,
    shippingCents,
    taxCents,
    normalizedEmail,
    shippingAddress,
    eligibleLocation,
    multiplierResolution,
    officialRules,
  } = quote;
  const orderId = randomUUID();
  const receipt = createCheckoutReceiptToken({
    tenantId: tenant.id,
    orderId,
    idempotencyKey: input.idempotencyKey,
  });

  return db.$transaction(async (tx) => {
    let entrant = authenticatedIdentity
      ? await tx.entrant.findFirst({
          where: {
            id: authenticatedIdentity.entrantId,
            tenantId: tenant.id,
            userId: authenticatedIdentity.userId,
            normalizedEmail,
          },
        })
      : await tx.entrant.findFirst({
          where: { tenantId: tenant.id, normalizedEmail },
          orderBy: { createdAt: "asc" },
        });
    if (authenticatedIdentity && !entrant) throw new Error("Verified account identity does not match checkout");
    if (!entrant) {
      entrant = await tx.entrant.create({
        data: {
          tenantId: tenant.id,
          normalizedEmail,
          emailHash: hashValue(normalizedEmail),
          name: input.name,
          phone: input.phone,
          region: eligibleLocation.normalizedRegion,
          postalCode: input.postalCode,
          country: eligibleLocation.normalizedCountry,
          eligibilityAttested: true,
        },
      });
    } else if (authenticatedIdentity || !entrant.userId) {
      entrant = await tx.entrant.update({
        where: { id: entrant.id },
        data: {
          name: input.name,
          phone: input.phone,
          region: eligibleLocation.normalizedRegion,
          postalCode: input.postalCode,
          country: eligibleLocation.normalizedCountry,
          eligibilityAttested: true,
        },
      });
    }

    const existingCampaignEntrant = await tx.campaignEntrant.findUnique({
      where: { campaignId_entrantId: { campaignId: campaign.id, entrantId: entrant.id } },
    });
    if (existingCampaignEntrant && existingCampaignEntrant.status !== "ELIGIBLE") {
      throw new Error("This entrant is not eligible for the promotion");
    }
    if (!existingCampaignEntrant) {
      await tx.campaignEntrant.create({
        data: {
          campaignId: campaign.id,
          entrantId: entrant.id,
          status: "ELIGIBLE",
          eligibilityJson: JSON.stringify({
            ageConfirmed: true,
            minimumAge: campaign.minimumAge,
            residenceConfirmed: true,
            country: eligibleLocation.normalizedCountry,
            region: eligibleLocation.normalizedRegion,
          }),
        },
      });
    }
    const account = await tx.entryAccount.upsert({
      where: { campaignId_entrantId: { campaignId: campaign.id, entrantId: entrant.id } },
      update: {},
      create: { tenantId: tenant.id, campaignId: campaign.id, entrantId: entrant.id },
    });

    let remaining = campaign.maxEntriesPerEntrant == null
      ? null
      : campaign.maxEntriesPerEntrant > account.balance
        ? campaign.maxEntriesPerEntrant - account.balance
        : 0n;
    const allocatedLines = quotedLines.map((quoted) => {
      const awarded = remaining == null
        ? quoted.calculation.finalEntries
        : quoted.calculation.finalEntries < remaining
          ? quoted.calculation.finalEntries
          : remaining;
      if (remaining != null) remaining -= awarded;
      return { ...quoted, awarded };
    });
    const entryTotal = allocatedLines.reduce((total, line) => total + line.awarded, 0n);
    const hasPhysical = allocatedLines.some((line) => line.product.productType === "PHYSICAL");

    const order = await tx.order.create({
      data: {
        id: orderId,
        tenantId: tenant.id,
        campaignId: campaign.id,
        entrantId: entrant.id,
        userId: entrant.userId,
        orderNumber: createOrderNumber(),
        channel: "WEB",
        status: "CONFIRMED",
        paymentStatus: "CAPTURED",
        fulfillmentStatus: allocatedLines.every((line) => line.product.productType === "DIGITAL") ? "FULFILLED" : "UNFULFILLED",
        email: normalizedEmail,
        customerName: input.name,
        currency: tenant.currency,
        subtotalCents,
        shippingCents,
        taxCents,
        totalCents: subtotalCents + shippingCents + taxCents,
        entryTotal,
        shippingAddressJson: JSON.stringify(shippingAddress),
        provider: "DEMO",
        providerPaymentId: `demo_${input.idempotencyKey}`,
        idempotencyKey: input.idempotencyKey,
        receiptTokenHash: hashCheckoutReceiptToken(receipt),
        inventoryReservationStatus: hasPhysical ? "COMMITTED" : "NONE",
        paidAt: now,
      },
    });

    for (const allocated of allocatedLines) {
      const calculationJson = JSON.stringify({
        ...allocated.calculation.snapshot,
        campaignConfigHash: campaign.configChecksum,
        officialRulesDocumentId: officialRules.id,
        officialRulesChecksum: officialRules.checksum,
        multiplierResolution: multiplierResolution.snapshot,
        purchaseRuleResolution: allocated.ruleResolution.snapshot,
        awardedAfterEntrantCap: allocated.awarded.toString(),
      });
      const orderLine = await tx.orderLine.create({
        data: {
          orderId: order.id,
          productId: allocated.product.id,
          variantId: allocated.variant.id,
          productTitle: allocated.product.title,
          variantTitle: allocated.variant.title,
          sku: allocated.variant.sku,
          quantity: allocated.line.quantity,
          unitPriceCents: allocated.unitPriceCents,
          qualifyingCents: allocated.calculation.qualifyingCents,
          entryMultiplier: allocated.ruleResolution.effectiveMultiplier,
          entries: allocated.awarded,
          entryCalculationJson: calculationJson,
        },
      });
      if (allocated.awarded > 0n) {
        const entitlement = await tx.entryEntitlement.create({
          data: {
            tenantId: tenant.id,
            entryAccountId: account.id,
            orderId: order.id,
            orderLineId: orderLine.id,
            originType: "ORDER_LINE",
            originalEntries: allocated.awarded,
            calculationJson,
            campaignConfigHash: campaign.configChecksum,
            idempotencyKey: `checkout:${input.idempotencyKey}:${orderLine.id}`,
            effectiveAt: now,
          },
        });
        await tx.entryLedgerEvent.create({
          data: {
            tenantId: tenant.id,
            entryAccountId: account.id,
            entitlementId: entitlement.id,
            kind: "GRANT",
            delta: allocated.awarded,
            idempotencyKey: `ledger:${input.idempotencyKey}:${orderLine.id}`,
            effectiveAt: now,
            reasonCode: "DEMO_PAYMENT_CAPTURED",
            metadataJson: JSON.stringify({ orderNumber: order.orderNumber, orderLineId: orderLine.id }),
          },
        });
      }
      if (allocated.product.productType === "PHYSICAL") {
        const inventoryUpdate = await tx.productVariant.updateMany({
          where: {
            id: allocated.variant.id,
            status: "ACTIVE",
            inventory: allocated.variant.inventory,
            reservedInventory: allocated.variant.reservedInventory,
          },
          data: { inventory: { decrement: allocated.line.quantity } },
        });
        if (inventoryUpdate.count !== 1) throw new Error(`${allocated.product.title} inventory changed; try again`);
        await tx.inventoryAdjustment.create({
          data: {
            tenantId: tenant.id,
            productId: allocated.product.id,
            variantId: allocated.variant.id,
            orderId: order.id,
            delta: -allocated.line.quantity,
            reasonCode: "ORDER_CAPTURED",
            idempotencyKey: `inventory:${input.idempotencyKey}:${allocated.variant.id}`,
            metadataJson: JSON.stringify({ orderNumber: order.orderNumber }),
          },
        });
      }
    }

    await tx.payment.create({
      data: {
        orderId: order.id,
        provider: "DEMO",
        providerEventId: `demo_event_${input.idempotencyKey}`,
        providerPaymentId: `demo_${input.idempotencyKey}`,
        status: "CAPTURED",
        amountCents: order.totalCents,
        currency: tenant.currency,
        payloadHash: hashValue(`${input.idempotencyKey}:${order.totalCents}`),
        idempotencyKey: `payment:${input.idempotencyKey}`,
        processedAt: now,
      },
    });
    if (entryTotal > 0n) {
      await tx.entryAccount.update({
        where: { id: account.id },
        data: { balance: { increment: entryTotal }, version: { increment: 1 } },
      });
    }

    const persistedOfficialRules = await tx.legalDocument.findFirst({
      where: {
        id: officialRules.id,
        tenantId: tenant.id,
        kind: "OFFICIAL_RULES",
        status: "PUBLISHED",
        version: campaign.rulesVersion,
        checksum: officialRules.checksum,
      },
    });
    if (!persistedOfficialRules) throw new Error("The campaign's exact published Official Rules are unavailable");
    await tx.rulesAcceptance.upsert({
      where: {
        campaignId_entrantId_legalDocumentId_method: {
          campaignId: campaign.id,
          entrantId: entrant.id,
          legalDocumentId: persistedOfficialRules.id,
          method: "CHECKOUT",
        },
      },
      update: {},
      create: {
        tenantId: tenant.id,
        campaignId: campaign.id,
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
          subjectHash: hashRateLimitIdentifier("consent:newsletter", normalizedEmail),
          channel: "EMAIL",
          action: "GRANTED",
          policyVersion: "checkout-v1",
          disclosure: "Send me product news and future promotion updates. Consent is optional and does not affect entry or odds.",
          source: "CHECKOUT",
        },
      });
      await tx.newsletterSubscriber.upsert({
        where: { tenantId_normalizedEmail: { tenantId: tenant.id, normalizedEmail } },
        update: { status: "SUBSCRIBED", unsubscribedAt: null },
        create: {
          tenantId: tenant.id,
          email: normalizedEmail,
          normalizedEmail,
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
        action: "DEMO_ORDER_CAPTURED",
        resourceType: "Order",
        resourceId: order.id,
        metadataJson: JSON.stringify({ orderNumber: order.orderNumber, entries: entryTotal.toString() }),
      },
    });
    await tx.outboxEvent.createMany({
      data: [
        {
          tenantId: tenant.id,
          aggregateType: "Order",
          aggregateId: order.id,
          kind: "ORDER_CONFIRMATION_EMAIL",
          payloadJson: JSON.stringify({ orderId: order.id }),
          idempotencyKey: `order-confirmation:${order.id}`,
        },
        {
          tenantId: tenant.id,
          aggregateType: "Order",
          aggregateId: order.id,
          kind: "FULFILLMENT_SUBMISSION",
          payloadJson: JSON.stringify({ orderId: order.id }),
          idempotencyKey: `fulfillment:${order.id}`,
        },
      ],
    });
    return { orderNumber: order.orderNumber, receipt, entries: entryTotal };
  });
}
