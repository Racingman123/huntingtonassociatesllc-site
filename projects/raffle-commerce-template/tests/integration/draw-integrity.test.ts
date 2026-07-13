import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { inspectCampaignReleaseIntegrity } from "@/server/campaigns/integrity";
import { db } from "@/server/db";
import { approveEntrySnapshot, buildEntrySnapshot, conductDemoDraw } from "@/server/draws/operations";
import {
  createEntrantAccount,
  createPromotion,
  createStaff,
  releasePromotionFixture,
} from "./fixtures";

afterAll(async () => db.$disconnect());

async function sealedFixture() {
  const { tenant, campaign } = await createPromotion({ closed: true, drawReady: true });
  const operations = await createStaff(tenant.id, "OPERATIONS");
  const compliance = await createStaff(tenant.id, "COMPLIANCE");
  await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, balance: 13n });
  await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, balance: 17n });
  await releasePromotionFixture(campaign.id);
  const built = await buildEntrySnapshot(campaign.id, operations.id);
  await approveEntrySnapshot({
    snapshotId: built.snapshot.id,
    actorId: operations.id,
    kind: "OPERATIONS_RECONCILIATION",
    notes: "Operations reconciled the canonical ledger and immutable snapshot rows.",
  });
  await approveEntrySnapshot({
    snapshotId: built.snapshot.id,
    actorId: compliance.id,
    kind: "COMPLIANCE_WITNESS",
    notes: "Compliance independently approved the canonical snapshot checksum.",
  });
  return { tenant, campaign, operations, compliance, snapshotId: built.snapshot.id };
}

describe.sequential("draw and release integrity", () => {
  test("freezes an approved campaign release and all reviewed child evidence", async () => {
    const { campaign } = await createPromotion({ closed: true, drawReady: true });
    await releasePromotionFixture(campaign.id);
    expect(await inspectCampaignReleaseIntegrity(db, campaign.id)).toMatchObject({ valid: true, reasons: [] });

    const prize = await db.campaignPrize.findFirstOrThrow({ where: { campaignId: campaign.id } });
    const rule = await db.entryRule.findFirstOrThrow({ where: { campaignId: campaign.id } });
    const approval = await db.campaignApproval.findFirstOrThrow({ where: { campaignId: campaign.id } });
    const filing = await db.filingRequirement.findFirstOrThrow({ where: { campaignId: campaign.id } });
    await expect(db.campaign.update({ where: { id: campaign.id }, data: { title: "Mutated after approval" } })).rejects.toThrow();
    await expect(db.campaignPrize.create({
      data: {
        tenantId: campaign.tenantId,
        campaignId: campaign.id,
        name: "Unauthorized second prize",
        description: "Must be rejected after publication.",
        approximateValueCents: 1,
      },
    })).rejects.toThrow();
    await expect(db.campaignPrize.update({ where: { id: prize.id }, data: { quantity: 2 } })).rejects.toThrow();
    await expect(db.entryRule.update({ where: { id: rule.id }, data: { entriesPerDollar: 999 } })).rejects.toThrow();
    await expect(db.campaignApproval.delete({ where: { id: approval.id } })).rejects.toThrow();
    await expect(db.filingRequirement.update({ where: { id: filing.id }, data: { evidenceRef: "test://replacement" } })).rejects.toThrow();
    expect(await inspectCampaignReleaseIntegrity(db, campaign.id)).toMatchObject({ valid: true, reasons: [] });
  });

  test("freezes canonical snapshot evidence and permits only the two-person approval transition", async () => {
    const { tenant, campaign } = await createPromotion({ closed: true, drawReady: true });
    const operations = await createStaff(tenant.id, "OPERATIONS");
    const compliance = await createStaff(tenant.id, "COMPLIANCE");
    const entrant = await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, balance: 10n });
    await releasePromotionFixture(campaign.id);
    const built = await buildEntrySnapshot(campaign.id, operations.id);
    const row = await db.entrySnapshotRow.findFirstOrThrow({ where: { snapshotId: built.snapshot.id } });
    const approval = await db.snapshotApproval.findFirstOrThrow({ where: { snapshotId: built.snapshot.id } });

    await expect(db.entrySnapshot.update({
      where: { id: built.snapshot.id },
      data: { checksum: "f".repeat(64) },
    })).rejects.toThrow();
    await expect(db.entrySnapshotRow.create({
      data: {
        snapshotId: built.snapshot.id,
        entryAccountId: entrant.account.id,
        entryCount: 1n,
        rangeStart: 11n,
        rangeEnd: 11n,
      },
    })).rejects.toThrow();
    await expect(db.entrySnapshotRow.update({ where: { id: row.id }, data: { rangeEnd: 99n } })).rejects.toThrow();
    await expect(db.entrySnapshotRow.delete({ where: { id: row.id } })).rejects.toThrow();
    await expect(db.snapshotApproval.delete({ where: { id: approval.id } })).rejects.toThrow();
    await expect(db.snapshotApproval.create({
      data: { snapshotId: built.snapshot.id, kind: `EXTRA-${randomUUID()}`, status: "PENDING" },
    })).rejects.toThrow();

    await approveEntrySnapshot({
      snapshotId: built.snapshot.id,
      actorId: operations.id,
      kind: "OPERATIONS_RECONCILIATION",
      notes: "Operations approved the exact immutable population.",
    });
    await approveEntrySnapshot({
      snapshotId: built.snapshot.id,
      actorId: compliance.id,
      kind: "COMPLIANCE_WITNESS",
      notes: "Compliance independently approved the exact immutable population.",
    });
    await expect(db.snapshotApproval.update({
      where: { id: approval.id },
      data: { notes: "Attempted post-approval evidence replacement." },
    })).rejects.toThrow();
    await expect(db.entryAccount.update({
      where: { id: entrant.account.id },
      data: { balance: 11n },
    })).rejects.toThrow();
  });

  test("serializes concurrent distinct approvals and always seals a completed quorum", async () => {
    const { tenant, campaign } = await createPromotion({ closed: true, drawReady: true });
    const operations = await createStaff(tenant.id, "OPERATIONS");
    const compliance = await createStaff(tenant.id, "COMPLIANCE");
    await createEntrantAccount({ tenantId: tenant.id, campaignId: campaign.id, balance: 23n });
    await releasePromotionFixture(campaign.id);
    const built = await buildEntrySnapshot(campaign.id, operations.id);

    const approvals = await Promise.all([
      approveEntrySnapshot({
        snapshotId: built.snapshot.id,
        actorId: operations.id,
        kind: "OPERATIONS_RECONCILIATION",
        notes: "Operations concurrently approved the exact canonical population.",
      }),
      approveEntrySnapshot({
        snapshotId: built.snapshot.id,
        actorId: compliance.id,
        kind: "COMPLIANCE_WITNESS",
        notes: "Compliance concurrently approved the exact canonical population.",
      }),
    ]);

    expect(approvals.some((approval) => approval.sealed)).toBe(true);
    const sealed = await db.entrySnapshot.findUniqueOrThrow({
      where: { id: built.snapshot.id },
      include: { approvals: true },
    });
    expect(sealed.status).toBe("SEALED");
    expect(sealed.sealedAt).not.toBeNull();
    expect(sealed.approvals.every((approval) => approval.status === "APPROVED")).toBe(true);
    expect(new Set(sealed.approvals.map((approval) => approval.approverId)).size).toBe(2);

    await expect(approveEntrySnapshot({
      snapshotId: built.snapshot.id,
      actorId: compliance.id,
      kind: "COMPLIANCE_WITNESS",
      notes: "Compliance replayed the already sealed approval.",
    })).resolves.toMatchObject({ sealed: true, idempotent: true });
  });

  test("serializes concurrent draw attempts and permanently binds one draw to one snapshot", async () => {
    const fixture = await sealedFixture();
    const attempts = await Promise.allSettled([
      conductDemoDraw(fixture.snapshotId, fixture.operations.id, 2),
      conductDemoDraw(fixture.snapshotId, fixture.operations.id, 2),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(await db.draw.count({ where: { snapshotId: fixture.snapshotId } })).toBe(1);

    const draw = await db.draw.findUniqueOrThrow({
      where: { snapshotId: fixture.snapshotId },
      include: { candidates: { orderBy: { rank: "asc" } } },
    });
    await expect(conductDemoDraw(fixture.snapshotId, fixture.operations.id, 1)).rejects.toThrow(/already has a draw/i);
    await expect(db.draw.update({ where: { id: draw.id }, data: { seedHash: "0".repeat(64) } })).rejects.toThrow();
    await expect(db.draw.delete({ where: { id: draw.id } })).rejects.toThrow();
    await expect(db.drawCandidate.update({
      where: { id: draw.candidates[0]!.id },
      data: { selectedEntry: 1n },
    })).rejects.toThrow();
    await expect(db.drawCandidate.delete({ where: { id: draw.candidates[0]!.id } })).rejects.toThrow();
    await expect(db.drawCandidate.create({
      data: {
        drawId: draw.id,
        entryAccountId: draw.candidates[0]!.entryAccountId,
        rank: 99,
        selectedEntry: 1n,
      },
    })).rejects.toThrow();

    // The controlled incident path can retain and void evidence, but a voided
    // snapshot remains single-use and cannot be redrawn.
    await db.drawCandidate.updateMany({ where: { drawId: draw.id }, data: { status: "VOID" } });
    await db.draw.update({ where: { id: draw.id }, data: { status: "VOID" } });
    await db.entrySnapshot.update({ where: { id: fixture.snapshotId }, data: { status: "VOID" } });
    await expect(conductDemoDraw(fixture.snapshotId, fixture.operations.id, 1)).rejects.toThrow(/sealed snapshot/i);
    expect(await db.draw.count({ where: { snapshotId: fixture.snapshotId } })).toBe(1);
  });
});
