import "server-only";

import { z } from "zod";
import { db } from "@/server/db";

const reviewSchema = z.object({
  tenantId: z.string().trim().min(1).max(191),
  submissionId: z.string().trim().min(1).max(191),
  actorId: z.string().trim().min(1).max(191),
  decision: z.enum(["APPROVE", "REJECT"]),
  reason: z.string().trim().min(5).max(500),
});

const mutableCampaignStates = ["LIVE", "ENTRY_CLOSED", "RECONCILING"];
const reviewRoles = ["ADMIN", "OPERATIONS", "COMPLIANCE"];

/**
 * Human review for production AMOE submissions. Approval posts through the
 * same append-only account, entitlement, and ledger used by paid entries.
 * The entrant cap is re-read at decision time so concurrent purchases cannot
 * push the account over the campaign maximum.
 */
export async function reviewFreeEntry(rawInput: unknown) {
  const input = reviewSchema.parse(rawInput);

  return db.$transaction(async (tx) => {
    const actor = await tx.user.findFirst({
      where: {
        id: input.actorId,
        tenantId: input.tenantId,
        status: "ACTIVE",
        role: { in: reviewRoles },
      },
      select: { id: true },
    });
    if (!actor) throw new Error("AMOE review requires an active authorized staff member");
    const submission = await tx.freeEntrySubmission.findFirst({
      where: { id: input.submissionId, tenantId: input.tenantId },
      include: {
        campaign: { include: { snapshots: { where: { status: "SEALED" }, select: { id: true }, take: 1 } } },
        entrant: true,
        entitlement: true,
      },
    });
    if (!submission) throw new Error("AMOE submission not found");

    const desiredStatus = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    if (submission.status === desiredStatus) return submission;
    if (!["PENDING", "REVIEW"].includes(submission.status)) {
      throw new Error(`AMOE submission in ${submission.status} cannot be reviewed`);
    }

    const now = new Date();
    if (input.decision === "REJECT") {
      const rejected = await tx.freeEntrySubmission.update({
        where: { id: submission.id },
        data: {
          status: "REJECTED",
          reviewedAt: now,
          reviewedBy: input.actorId,
          rejectionReason: input.reason,
        },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: input.tenantId,
          actorType: "ADMIN",
          actorId: input.actorId,
          action: "FREE_ENTRY_REJECTED",
          resourceType: "FreeEntrySubmission",
          resourceId: submission.id,
          reason: input.reason,
          metadataJson: JSON.stringify({ confirmationCode: submission.confirmationCode }),
        },
      });
      await tx.outboxEvent.create({
        data: {
          tenantId: input.tenantId,
          aggregateType: "FreeEntrySubmission",
          aggregateId: submission.id,
          kind: "FREE_ENTRY_REVIEWED_NOTIFICATION",
          payloadJson: JSON.stringify({ submissionId: submission.id, status: "REJECTED" }),
          idempotencyKey: `free-entry-reviewed:${submission.id}`,
        },
      });
      return rejected;
    }

    if (!mutableCampaignStates.includes(submission.campaign.status) || submission.campaign.snapshots.length) {
      throw new Error("Campaign entries are sealed or no longer mutable");
    }
    if (!submission.entrant.eligibilityAttested) {
      throw new Error("Entrant eligibility has not been attested");
    }
    const campaignEntrant = await tx.campaignEntrant.findUnique({
      where: {
        campaignId_entrantId: {
          campaignId: submission.campaignId,
          entrantId: submission.entrantId,
        },
      },
      select: { id: true, status: true, updatedAt: true },
    });
    if (!campaignEntrant || campaignEntrant.status !== "ELIGIBLE") {
      throw new Error("Campaign entrant is not eligible for an AMOE grant");
    }
    const eligibilityClaimedAt = new Date(Math.max(Date.now(), campaignEntrant.updatedAt.getTime() + 1));
    const eligibilityClaim = await tx.campaignEntrant.updateMany({
      where: {
        id: campaignEntrant.id,
        campaignId: submission.campaignId,
        entrantId: submission.entrantId,
        status: "ELIGIBLE",
        updatedAt: campaignEntrant.updatedAt,
      },
      data: { updatedAt: eligibilityClaimedAt },
    });
    if (eligibilityClaim.count !== 1) {
      throw new Error("Campaign entrant eligibility changed during AMOE review; retry the decision");
    }
    if (submission.entitlement) {
      throw new Error("Submission already has an entry entitlement");
    }

    const account = await tx.entryAccount.upsert({
      where: {
        campaignId_entrantId: {
          campaignId: submission.campaignId,
          entrantId: submission.entrantId,
        },
      },
      update: {},
      create: {
        tenantId: input.tenantId,
        campaignId: submission.campaignId,
        entrantId: submission.entrantId,
      },
    });
    const remaining = submission.campaign.maxEntriesPerEntrant == null
      ? submission.entriesRequested
      : submission.campaign.maxEntriesPerEntrant > account.balance
        ? submission.campaign.maxEntriesPerEntrant - account.balance
        : 0n;
    const entries = submission.entriesRequested < remaining ? submission.entriesRequested : remaining;
    if (entries <= 0n) throw new Error("Entrant has already reached the campaign cap");

    const entitlement = await tx.entryEntitlement.create({
      data: {
        tenantId: input.tenantId,
        entryAccountId: account.id,
        freeEntrySubmissionId: submission.id,
        originType: "FREE_ENTRY",
        status: "POSTED",
        originalEntries: entries,
        calculationJson: JSON.stringify({
          schemaVersion: 1,
          method: submission.method,
          rulesVersion: submission.rulesVersion,
          entriesRequested: submission.entriesRequested.toString(),
          awardedAfterEntrantCap: entries.toString(),
          reviewedBy: input.actorId,
        }),
        campaignConfigHash: submission.campaign.configChecksum,
        idempotencyKey: `free-entry:${submission.id}`,
        effectiveAt: submission.submittedAt,
      },
    });
    await tx.entryLedgerEvent.create({
      data: {
        tenantId: input.tenantId,
        entryAccountId: account.id,
        entitlementId: entitlement.id,
        kind: "GRANT",
        delta: entries,
        idempotencyKey: `free-entry-ledger:${submission.id}`,
        effectiveAt: submission.submittedAt,
        actorType: "ADMIN",
        actorId: input.actorId,
        reasonCode: "AMOE_APPROVED",
        metadataJson: JSON.stringify({
          confirmationCode: submission.confirmationCode,
          reviewReason: input.reason,
        }),
      },
    });
    const accountUpdate = await tx.entryAccount.updateMany({
      where: { id: account.id, version: account.version, balance: account.balance },
      data: { balance: { increment: entries }, version: { increment: 1 } },
    });
    if (accountUpdate.count !== 1) {
      throw new Error("Entry account changed during review; retry the decision");
    }
    const approved = await tx.freeEntrySubmission.update({
      where: { id: submission.id },
      data: {
        status: "APPROVED",
        reviewedAt: now,
        reviewedBy: input.actorId,
        rejectionReason: null,
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: "ADMIN",
        actorId: input.actorId,
        action: "FREE_ENTRY_APPROVED",
        resourceType: "FreeEntrySubmission",
        resourceId: submission.id,
        reason: input.reason,
        metadataJson: JSON.stringify({
          confirmationCode: submission.confirmationCode,
          entries: entries.toString(),
          entitlementId: entitlement.id,
        }),
      },
    });
    await tx.outboxEvent.create({
      data: {
        tenantId: input.tenantId,
        aggregateType: "FreeEntrySubmission",
        aggregateId: submission.id,
        kind: "FREE_ENTRY_REVIEWED_NOTIFICATION",
        payloadJson: JSON.stringify({ submissionId: submission.id, status: "APPROVED" }),
        idempotencyKey: `free-entry-reviewed:${submission.id}`,
      },
    });
    return approved;
  });
}
