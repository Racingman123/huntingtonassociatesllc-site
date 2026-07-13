import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { db } from "@/server/db";
import { runMaintenance } from "@/server/maintenance/service";
import { activateScheduledCampaigns } from "@/server/campaigns/scheduler";
import { inspectCampaignReleaseIntegrity } from "@/server/campaigns/integrity";
import { createPromotion, releasePromotionFixture } from "./fixtures";

afterAll(async () => {
  await db.$disconnect();
});

describe.sequential("scheduled campaign activation", () => {
  test("closes an ended campaign, opens only the earliest due successor, and audits both", async () => {
    const now = new Date("2032-05-10T12:00:00.000Z");
    const { tenant, campaign, rules } = await createPromotion();
    await db.campaign.update({
      where: { id: campaign.id },
      data: {
        startsAt: new Date("2032-04-01T00:00:00.000Z"),
        endsAt: new Date("2032-05-10T11:00:00.000Z"),
        freeEntryEndsAt: new Date("2032-05-10T11:00:00.000Z"),
      },
    });

    const createScheduled = (position: number) => db.campaign.create({
      data: {
        tenantId: tenant.id,
        slug: `scheduled-${position}-${randomUUID()}`,
        code: `SCHEDULED-${position}-${randomUUID()}`,
        title: `Scheduled campaign ${position}`,
        shortDescription: "A reviewed scheduled promotion.",
        longDescription: "A reviewed scheduled promotion waiting for its authoritative opening instant.",
        status: "SCHEDULED",
        startsAt: new Date(`2032-05-10T0${position}:00:00.000Z`),
        endsAt: new Date("2032-06-10T12:00:00.000Z"),
        freeEntryEndsAt: new Date("2032-06-10T12:00:00.000Z"),
        eligibilitySummary: "Eligible test entrants only.",
        rulesVersion: rules.version,
        officialRulesDocumentId: rules.id,
        officialRulesChecksum: rules.checksum,
        configChecksum: randomUUID().replaceAll("-", "").repeat(2),
        approvedAt: null,
      },
    });
    const first = await createScheduled(1);
    const second = await createScheduled(2);
    for (const scheduled of [first, second]) await releasePromotionFixture(scheduled.id);
    expect(await inspectCampaignReleaseIntegrity(db, first.id)).toMatchObject({ valid: true, reasons: [] });
    expect(await inspectCampaignReleaseIntegrity(db, second.id)).toMatchObject({ valid: true, reasons: [] });

    const result = await runMaintenance(now);
    expect(result.campaignsClosed).toBe(1);
    expect(result.campaignActivation).toMatchObject({ scanned: 2, opened: 1, expired: 0, skipped: 1, failures: 0 });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("ENTRY_CLOSED");
    expect((await db.campaign.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("LIVE");
    expect((await db.campaign.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("SCHEDULED");

    const actions = await db.auditEvent.findMany({
      where: { tenantId: tenant.id, action: { in: ["CAMPAIGN_ENTRY_CLOSED", "CAMPAIGN_OPENED"] } },
      select: { action: true, resourceId: true },
    });
    expect(actions).toEqual(expect.arrayContaining([
      { action: "CAMPAIGN_ENTRY_CLOSED", resourceId: campaign.id },
      { action: "CAMPAIGN_OPENED", resourceId: first.id },
    ]));
  });

  test("rejects protected catalog changes and skips activation after out-of-band catalog drift", async () => {
    const now = new Date();
    const { tenant, rules } = await createPromotion({ closed: true });
    const product = await db.product.findFirstOrThrow({
      where: { tenantId: tenant.id, status: "ACTIVE", productType: { not: "MEMBERSHIP" } },
      include: { variants: true },
    });
    const scheduled = await db.campaign.create({
      data: {
        tenantId: tenant.id,
        slug: `catalog-bound-${randomUUID()}`,
        code: `CATALOG-BOUND-${randomUUID()}`,
        title: "Catalog-bound scheduled campaign",
        shortDescription: "A scheduled release bound to exact catalog targeting facts.",
        longDescription: "This campaign must not activate after its reviewed purchase catalog changes.",
        status: "SCHEDULED",
        startsAt: new Date(now.getTime() - 60_000),
        endsAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        freeEntryEndsAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        drawAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
        eligibilitySummary: "Eligible test entrants only.",
        rulesVersion: rules.version,
        officialRulesDocumentId: rules.id,
        officialRulesChecksum: rules.checksum,
        configChecksum: "0".repeat(64),
        approvedAt: null,
        entryRules: {
          create: [
            {
              name: "Reviewed category target",
              ruleType: "MONEY_RATE",
              targetType: "CATEGORY",
              targetId: product.category,
              entriesPerDollar: 1,
              stackPriority: 0,
            },
            {
              name: "Free online entry",
              ruleType: "AMOE_FIXED",
              targetType: "FREE_ENTRY",
              baseEntries: 1000n,
              stackPriority: 100,
            },
          ],
        },
      },
    });
    await releasePromotionFixture(scheduled.id);
    expect(await inspectCampaignReleaseIntegrity(db, scheduled.id)).toMatchObject({ valid: true });

    await expect(db.product.update({
      where: { id: product.id },
      data: { category: "Changed after publication" },
    })).rejects.toThrow(/constraint|scheduled\/live campaign catalog is immutable/i);

    // Simulate an out-of-band import performed with a privileged role that did
    // not install the runtime guard. Activation must still recompute the
    // manifest and rule coverage instead of trusting the old approval digest.
    await db.$executeRawUnsafe("DROP TRIGGER protected_campaign_catalog_product_no_update");
    await db.product.update({
      where: { id: product.id },
      data: { category: "Changed after publication" },
    });
    const drifted = await inspectCampaignReleaseIntegrity(db, scheduled.id);
    expect(drifted.valid).toBe(false);
    expect(drifted.reasons).toEqual(expect.arrayContaining([
      expect.stringMatching(/current campaign release or bound catalog differs from immutable release evidence/i),
      expect.stringMatching(/does not resolve to an active purchasable non-membership variant/i),
    ]));

    expect(await activateScheduledCampaigns(now)).toMatchObject({
      scanned: 1,
      opened: 0,
      skipped: 1,
      failures: 0,
    });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: scheduled.id } }))
      .toMatchObject({ status: "SCHEDULED" });
  });
});
