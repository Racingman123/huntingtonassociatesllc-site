import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { completeDemoCheckout, loadAuthoritativeCheckoutQuote } from "@/server/commerce/checkout";
import { startStripeCheckout } from "@/server/commerce/stripe-checkout";
import { submitFreeEntry } from "@/server/entries/free-entry";
import { db } from "@/server/db";
import { checkoutInput, createProduct, createPromotion, freeEntryInput } from "./fixtures";

afterAll(async () => {
  await db.$disconnect();
});

describe.sequential("Official Rules and purchase-entry parity", () => {
  test("a later published rules version does not change live checkout or AMOE acceptance", async () => {
    const { tenant, campaign, rules } = await createPromotion({ multiplier: 2 });
    const product = await createProduct({ tenantId: tenant.id, priceCents: 2_500 });
    await db.legalDocument.create({
      data: {
        tenantId: tenant.id,
        kind: "OFFICIAL_RULES",
        slug: "official-rules",
        title: "Future Official Rules",
        version: 2,
        body: "NO PURCHASE NECESSARY. Future campaign only.",
        checksum: "f".repeat(64),
        status: "PUBLISHED",
        effectiveAt: new Date(),
      },
    });

    await completeDemoCheckout(checkoutInput({
      email: "bound-checkout@example.test",
      lines: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1 }],
    }), tenant.slug);
    await submitFreeEntry(freeEntryInput(campaign.slug, "bound-free@example.test"), tenant.id);

    const acceptances = await db.rulesAcceptance.findMany({
      where: { campaignId: campaign.id },
      orderBy: { method: "asc" },
    });
    expect(acceptances).toHaveLength(2);
    expect(acceptances.map((acceptance) => acceptance.legalDocumentId)).toEqual([rules.id, rules.id]);
    expect(acceptances.map((acceptance) => acceptance.documentChecksum)).toEqual([rules.checksum, rules.checksum]);
    await expect(db.campaign.update({
      where: { id: campaign.id },
      data: { officialRulesChecksum: "0".repeat(64) },
    })).rejects.toThrow();
    await expect(db.legalDocument.update({
      where: { id: rules.id },
      data: { body: "Changed after publication" },
    })).rejects.toThrow();
  });

  test("category, product, and variant rules match the authoritative base-rate quote exactly", async () => {
    const { tenant, campaign } = await createPromotion({ multiplier: 3, baseEntriesPerDollar: 2 });
    const product = await createProduct({
      tenantId: tenant.id,
      priceCents: 1_050,
      entryMultiplier: 5,
      category: "Gear",
    });
    const variant = product.variants[0];
    await db.entryRule.createMany({
      data: [
        { campaignId: campaign.id, name: "Gear 2X", ruleType: "MONEY_RATE", targetType: "CATEGORY", targetId: "Gear", multiplierNumerator: 2, stackPriority: 10 },
        { campaignId: campaign.id, name: "Product 3X", ruleType: "MONEY_RATE", targetType: "PRODUCT", targetId: product.slug, multiplierNumerator: 3, stackPriority: 20 },
        { campaignId: campaign.id, name: "Variant 2X", ruleType: "MONEY_RATE", targetType: "VARIANT", targetId: variant.sku, multiplierNumerator: 2, stackPriority: 30 },
      ],
    });
    const input = checkoutInput({
      email: "entry-parity@example.test",
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, variantId: variant.id, quantity: 2 }],
    });
    const quote = await loadAuthoritativeCheckoutQuote(input, tenant.slug);
    expect(quote.quotedLines[0].calculation.finalEntries).toBe(7_560n);
    expect(quote.quotedLines[0].ruleResolution.snapshot).toMatchObject({
      baseEntriesPerCurrencyUnit: 2,
      catalogProductMultiplier: 5,
      campaignMultiplier: 3,
      purchaseRuleMultiplier: 12,
      effectiveMultiplier: 180,
    });
    expect(quote.quotedLines[0].ruleResolution.snapshot.matchedRules.map((rule) => rule.targetType))
      .toEqual(["ALL", "CATEGORY", "PRODUCT", "VARIANT"]);

    const completed = await completeDemoCheckout(input, tenant.slug);
    expect(completed.entries).toBe(quote.quotedLines[0].calculation.finalEntries);
    const line = await db.orderLine.findFirstOrThrow({
      where: { order: { tenantId: tenant.id, idempotencyKey: input.idempotencyKey } },
    });
    expect(line.entries).toBe(7_560n);
    expect(JSON.parse(line.entryCalculationJson)).toMatchObject({
      baseEntriesPerDollar: 2,
      productMultiplier: 5,
      purchaseRuleMultiplier: 12,
      campaignMultiplier: 3,
      purchaseRuleResolution: { semantics: "MULTIPLY_DISTINCT_PRIORITIES" },
    });
  });

  test("ambiguous active matching rules fail closed before order creation", async () => {
    const { tenant, campaign } = await createPromotion();
    const product = await createProduct({ tenantId: tenant.id });
    await db.entryRule.create({
      data: {
        campaignId: campaign.id,
        name: "Ambiguous product rule",
        ruleType: "MONEY_RATE",
        targetType: "PRODUCT",
        targetId: product.id,
        stackPriority: 0,
      },
    });
    const input = checkoutInput({
      email: "ambiguous@example.test",
      lines: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1 }],
    });
    await expect(loadAuthoritativeCheckoutQuote(input, tenant.slug)).rejects.toThrow(/Ambiguous purchase-entry rules/);
    expect(await db.order.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  test("ordinary demo and Stripe checkout reject recurring membership products", async () => {
    const { tenant } = await createPromotion();
    const membership = await createProduct({
      tenantId: tenant.id,
      productType: "MEMBERSHIP",
      category: "Membership",
    });
    const input = checkoutInput({
      email: "ordinary-membership@example.test",
      lines: [{
        productId: membership.id,
        variantId: membership.variants[0].id,
        quantity: 1,
      }],
    });

    await expect(loadAuthoritativeCheckoutQuote(input, tenant.slug))
      .rejects.toThrow(/membership products must be purchased through recurring enrollment/i);
    await expect(completeDemoCheckout(input, tenant.slug))
      .rejects.toThrow(/membership products must be purchased through recurring enrollment/i);

    let providerCalled = false;
    await expect(startStripeCheckout(input, tenant.slug, {
      async createForPreparedOrder() {
        providerCalled = true;
        return {
          providerCheckoutId: "cs_membership_must_not_exist",
          redirectUrl: "https://checkout.stripe.test/membership-must-not-exist",
        };
      },
    })).rejects.toThrow(/membership products must be purchased through recurring enrollment/i);
    expect(providerCalled).toBe(false);
    expect(await db.order.count({ where: { tenantId: tenant.id } })).toBe(0);
  });
});
