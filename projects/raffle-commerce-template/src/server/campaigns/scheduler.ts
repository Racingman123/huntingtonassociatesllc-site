import "server-only";

import { Prisma } from "@prisma/client";
import { db } from "@/server/db";
import { inspectCampaignReleaseIntegrity } from "./integrity";

export type CampaignActivationResult = {
  scanned: number;
  opened: number;
  expired: number;
  skipped: number;
  failures: number;
};

/**
 * Activates due, pre-approved campaigns without ever choosing between two
 * overlapping promotions. A tenant-row write serializes concurrent workers;
 * the second worker then observes the LIVE campaign and fails closed.
 */
export async function activateScheduledCampaigns(
  now = new Date(),
  limit = 100,
): Promise<CampaignActivationResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Campaign activation limit must be an integer from 1 to 500");
  }
  const due = await db.campaign.findMany({
    where: { status: "SCHEDULED", startsAt: { lte: now } },
    select: { id: true, tenantId: true, code: true, startsAt: true },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    take: limit,
  });
  const result: CampaignActivationResult = {
    scanned: due.length,
    opened: 0,
    expired: 0,
    skipped: 0,
    failures: 0,
  };

  for (const campaign of due) {
    try {
      const disposition = await db.$transaction(async (tx) => {
        // This deliberate write is a portable per-tenant mutex under the
        // serializable isolation required for production campaign activation.
        await tx.tenant.update({
          where: { id: campaign.tenantId },
          data: { updatedAt: now },
        });
        const current = await tx.campaign.findFirst({
          where: { id: campaign.id, tenantId: campaign.tenantId, status: "SCHEDULED" },
          include: {
            officialRulesDocument: true,
            approvals: {
              where: {
                status: "APPROVED",
                kind: { in: ["SPONSOR_ADMIN_PUBLICATION", "COMPLIANCE_WITNESS_PUBLICATION"] },
              },
            },
          },
        });
        if (!current) return "SKIPPED" as const;
        const releaseIntegrity = await inspectCampaignReleaseIntegrity(tx, current.id);
        if (!releaseIntegrity.valid) return "SKIPPED" as const;
        const entryEndsAt = current.freeEntryEndsAt > current.endsAt
          ? current.freeEntryEndsAt
          : current.endsAt;
        if (entryEndsAt <= now) {
          const expired = await tx.campaign.updateMany({
            where: { id: current.id, tenantId: current.tenantId, status: "SCHEDULED" },
            data: { status: "CANCELLED" },
          });
          if (expired.count !== 1) return "SKIPPED" as const;
          await tx.auditEvent.create({
            data: {
              tenantId: current.tenantId,
              actorType: "SYSTEM",
              actorId: "maintenance-worker",
              action: "CAMPAIGN_SCHEDULE_EXPIRED",
              resourceType: "Campaign",
              resourceId: current.id,
              metadataJson: JSON.stringify({ code: current.code, entryEndsAt: entryEndsAt.toISOString() }),
            },
          });
          return "EXPIRED" as const;
        }
        const sponsorApproval = current.approvals.find((approval) => approval.kind === "SPONSOR_ADMIN_PUBLICATION");
        const complianceApproval = current.approvals.find((approval) => approval.kind === "COMPLIANCE_WITNESS_PUBLICATION");
        if (
          !current.approvedAt
          || current.configChecksum.length !== 64
          || !current.officialRulesDocumentId
          || !current.officialRulesChecksum
          || current.officialRulesDocument?.id !== current.officialRulesDocumentId
          || current.officialRulesDocument.tenantId !== current.tenantId
          || current.officialRulesDocument.kind !== "OFFICIAL_RULES"
          || current.officialRulesDocument.status !== "PUBLISHED"
          || current.officialRulesDocument.version !== current.rulesVersion
          || current.officialRulesDocument.checksum !== current.officialRulesChecksum
          || !current.officialRulesDocument.effectiveAt
          || current.officialRulesDocument.effectiveAt > current.startsAt
          || sponsorApproval?.configChecksum !== current.configChecksum
          || complianceApproval?.configChecksum !== current.configChecksum
          || sponsorApproval.rulesChecksum !== current.officialRulesChecksum
          || complianceApproval.rulesChecksum !== current.officialRulesChecksum
          || !sponsorApproval.approverId
          || !complianceApproval.approverId
          || sponsorApproval.approverId === complianceApproval.approverId
        ) {
          return "SKIPPED" as const;
        }
        const competingLive = await tx.campaign.count({
          where: { tenantId: campaign.tenantId, status: "LIVE" },
        });
        if (competingLive > 0) return "SKIPPED" as const;

        const opened = await tx.campaign.updateMany({
          where: {
            id: campaign.id,
            tenantId: campaign.tenantId,
            status: "SCHEDULED",
            startsAt: { lte: now },
          },
          data: { status: "LIVE" },
        });
        if (opened.count !== 1) return "SKIPPED" as const;
        await tx.auditEvent.create({
          data: {
            tenantId: campaign.tenantId,
            actorType: "SYSTEM",
            actorId: "maintenance-worker",
            action: "CAMPAIGN_OPENED",
            resourceType: "Campaign",
            resourceId: campaign.id,
            metadataJson: JSON.stringify({
              code: campaign.code,
              scheduledStart: campaign.startsAt.toISOString(),
              openedAt: now.toISOString(),
            }),
          },
        });
        return "OPENED" as const;
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 10_000,
      });
      if (disposition === "OPENED") result.opened += 1;
      else if (disposition === "EXPIRED") result.expired += 1;
      else result.skipped += 1;
    } catch {
      result.failures += 1;
    }
  }
  return result;
}
