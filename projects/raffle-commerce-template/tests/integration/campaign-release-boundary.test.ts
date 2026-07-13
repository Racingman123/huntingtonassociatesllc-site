import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { inspectCampaignReleaseIntegrity } from "@/server/campaigns/integrity";
import { db } from "@/server/db";
import { buildEntrySnapshot } from "@/server/draws/operations";
import {
  createEntrantAccount,
  createProduct,
  createPromotion,
  createStaff,
  releasePromotionFixture,
} from "./fixtures";

afterAll(async () => db.$disconnect());

describe.sequential("campaign release catalog boundary", () => {
  test("post-close catalog preparation cannot invalidate the immutable release used for a snapshot", async () => {
    const { tenant, campaign } = await createPromotion({ closed: true, drawReady: true });
    const operator = await createStaff(tenant.id, "OPERATIONS");
    await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, balance: 100n });
    await releasePromotionFixture(campaign.id);
    const releasedProduct = await db.product.findFirstOrThrow({
      where: { tenantId: tenant.id, productType: { not: "MEMBERSHIP" }, status: "ACTIVE" },
    });

    await db.product.update({
      where: { id: releasedProduct.id },
      data: {
        status: "INACTIVE",
        priceCents: releasedProduct.priceCents + 1_000,
        title: "Catalog prepared for the next campaign",
      },
    });

    const integrity = await inspectCampaignReleaseIntegrity(db, campaign.id);
    expect(integrity).toMatchObject({ valid: true, catalogReadiness: { ready: true } });
    const built = await buildEntrySnapshot(campaign.id, operator.id);
    expect(built.snapshot).toMatchObject({ status: "AWAITING_APPROVAL", totalEntries: 100n });
  });

  test("membership transaction facts are immutable while live and can change after close without rewriting release evidence", async () => {
    const { tenant, campaign } = await createPromotion();
    const product = await createProduct({
      tenantId: tenant.id,
      productType: "MEMBERSHIP",
      category: "Membership",
      priceCents: 2_500,
    });
    const plan = await db.subscriptionPlan.create({
      data: {
        tenantId: tenant.id,
        productId: product.id,
        name: "Protected live membership",
        status: "ACTIVE",
        interval: "MONTH",
        intervalCount: 1,
        priceCents: 2_500,
        currency: "USD",
        baseEntries: 100n,
        providerPriceId: `price_${randomUUID()}`,
      },
    });
    await db.membershipEntryBand.create({
      data: {
        campaignId: campaign.id,
        planId: plan.id,
        minimumSettledCycles: 0,
        fixedEntries: 100n,
      },
    });
    await releasePromotionFixture(campaign.id);

    await expect(db.subscriptionPlan.update({
      where: { id: plan.id },
      data: { priceCents: 3_000, providerPriceId: `price_${randomUUID()}` },
    })).rejects.toThrow();
    await expect(db.product.update({
      where: { id: product.id },
      data: { title: "Drifted membership product" },
    })).rejects.toThrow();
    await expect(db.productVariant.create({
      data: {
        tenantId: tenant.id,
        productId: product.id,
        sku: `MEMBERSHIP-${randomUUID()}`,
        title: "Drifted option",
        status: "ACTIVE",
        inventory: 1,
      },
    })).rejects.toThrow();
    expect(await inspectCampaignReleaseIntegrity(db, campaign.id)).toMatchObject({ valid: true });

    await db.campaign.update({ where: { id: campaign.id }, data: { status: "ENTRY_CLOSED" } });
    await db.subscriptionPlan.update({
      where: { id: plan.id },
      data: { priceCents: 3_000, providerPriceId: `price_${randomUUID()}` },
    });
    await db.product.update({ where: { id: product.id }, data: { title: "Next campaign membership" } });
    expect(await inspectCampaignReleaseIntegrity(db, campaign.id)).toMatchObject({ valid: true });
  });
});
