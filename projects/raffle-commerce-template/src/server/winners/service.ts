import "server-only";

import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/server/db";

const id = z.string().trim().min(1).max(191);
const reason = z.string().trim().min(10).max(1_000);

const contactSchema = z.object({
  tenantId: id,
  candidateId: id,
  actorId: id,
  contactDeadline: z.date(),
});

const decisionSchema = z.object({
  tenantId: id,
  candidateId: id,
  actorId: id,
  decision: z.enum(["VERIFY", "DISQUALIFY"]),
  reason,
});

const publicationSchema = z.object({
  tenantId: id,
  winnerId: id,
  actorId: id,
  publicName: z.string().trim().min(2).max(100),
  publicLocation: z.string().trim().min(2).max(100),
  quote: z.string().trim().max(500).optional(),
  publicationConsentConfirmed: z.literal(true),
});

const fulfillmentSchema = z.object({
  tenantId: id,
  winnerId: id,
  actorId: id,
  evidenceReference: z.string().trim().min(5).max(500),
});

type WinnerTx = Prisma.TransactionClient;

async function requireRole(
  tx: WinnerTx,
  input: { tenantId: string; actorId: string; roles: string[] },
) {
  const user = await tx.user.findFirst({
    where: {
      id: input.actorId,
      tenantId: input.tenantId,
      status: "ACTIVE",
      role: { in: input.roles },
    },
    select: { id: true },
  });
  if (!user) throw new Error("The authenticated operator is not authorized for this winner step");
}

async function loadCandidate(tx: WinnerTx, tenantId: string, candidateId: string) {
  const candidate = await tx.drawCandidate.findFirst({
    where: { id: candidateId, draw: { tenantId } },
    include: {
      winner: true,
      account: { include: { entrant: true } },
      draw: {
        include: {
          campaign: { include: { prizes: { orderBy: { sortOrder: "asc" } } } },
          candidates: { orderBy: { rank: "asc" } },
        },
      },
    },
  });
  if (!candidate) throw new Error("Draw candidate not found");
  return candidate;
}

function assertCurrentCandidate(candidate: Awaited<ReturnType<typeof loadCandidate>>) {
  const unresolvedEarlier = candidate.draw.candidates.some((other) => (
    other.rank < candidate.rank && other.status !== "DISQUALIFIED"
  ));
  if (unresolvedEarlier) {
    throw new Error("An earlier-ranked candidate must be resolved before this alternate");
  }
  if (!candidate.draw.campaign.prizes[0]) throw new Error("Campaign prize schedule is unavailable");
  if (candidate.draw.status !== "VERIFYING") throw new Error("Draw is not in candidate verification");
}

export async function recordCandidateContact(rawInput: unknown) {
  const input = contactSchema.parse(rawInput);
  const now = new Date();
  if (input.contactDeadline <= now || input.contactDeadline > new Date(now.getTime() + 60 * 86_400_000)) {
    throw new Error("Contact deadline must be within the next 60 days");
  }
  return db.$transaction(async (tx) => {
    await requireRole(tx, { tenantId: input.tenantId, actorId: input.actorId, roles: ["ADMIN", "OPERATIONS", "COMPLIANCE"] });
    const candidate = await loadCandidate(tx, input.tenantId, input.candidateId);
    assertCurrentCandidate(candidate);
    if (!["CONTACTING", "ALTERNATE"].includes(candidate.status)) {
      throw new Error(`Candidate in ${candidate.status} cannot be contacted`);
    }
    const updated = await tx.drawCandidate.updateMany({
      where: { id: candidate.id, status: candidate.status },
      data: { status: "CONTACTING", contactDeadline: input.contactDeadline },
    });
    if (updated.count !== 1) throw new Error("Candidate changed while contact was recorded; retry");
    await tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: "ADMIN",
        actorId: input.actorId,
        action: "DRAW_CANDIDATE_CONTACT_RECORDED",
        resourceType: "DrawCandidate",
        resourceId: candidate.id,
        metadataJson: JSON.stringify({ rank: candidate.rank, deadline: input.contactDeadline.toISOString() }),
      },
    });
    return tx.drawCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
  });
}

export async function decideDrawCandidate(rawInput: unknown) {
  const input = decisionSchema.parse(rawInput);
  return db.$transaction(async (tx) => {
    await requireRole(tx, { tenantId: input.tenantId, actorId: input.actorId, roles: ["ADMIN", "COMPLIANCE"] });
    const candidate = await loadCandidate(tx, input.tenantId, input.candidateId);
    if (candidate.winner && candidate.status === "VERIFIED" && input.decision === "VERIFY") {
      return { candidate, winner: candidate.winner, idempotent: true };
    }
    if (
      candidate.status === "DISQUALIFIED"
      && candidate.decisionReason === input.reason
      && input.decision === "DISQUALIFY"
    ) {
      return { candidate, winner: null, idempotent: true };
    }
    assertCurrentCandidate(candidate);
    if (candidate.status !== "CONTACTING") {
      throw new Error(`Candidate in ${candidate.status} cannot receive a verification decision`);
    }
    if (!candidate.contactDeadline) {
      throw new Error("Candidate contact and a response deadline must be recorded before a decision");
    }
    if (input.decision === "VERIFY" && candidate.contactDeadline <= new Date()) {
      throw new Error("Candidate response deadline has passed; record a rules-based disqualification decision");
    }

    if (input.decision === "DISQUALIFY") {
      const changed = await tx.drawCandidate.updateMany({
        where: { id: candidate.id, status: "CONTACTING" },
        data: { status: "DISQUALIFIED", decisionReason: input.reason, verifiedAt: null },
      });
      if (changed.count !== 1) throw new Error("Candidate changed while the decision was recorded; retry");
      const next = candidate.draw.candidates.find((other) => other.rank > candidate.rank);
      if (next) {
        await tx.drawCandidate.updateMany({
          where: { id: next.id, status: "ALTERNATE" },
          data: { status: "CONTACTING" },
        });
      } else {
        await tx.draw.update({ where: { id: candidate.drawId }, data: { status: "EXHAUSTED" } });
      }
      await tx.auditEvent.create({
        data: {
          tenantId: input.tenantId,
          actorType: "ADMIN",
          actorId: input.actorId,
          action: "DRAW_CANDIDATE_DISQUALIFIED",
          resourceType: "DrawCandidate",
          resourceId: candidate.id,
          reason: input.reason,
          metadataJson: JSON.stringify({ rank: candidate.rank, nextCandidateId: next?.id ?? null }),
        },
      });
      return { candidate: await tx.drawCandidate.findUniqueOrThrow({ where: { id: candidate.id } }), winner: null, idempotent: false };
    }

    const unresolvedAdjustments = await tx.entryAdjustmentRequest.count({
      where: {
        tenantId: input.tenantId,
        campaignId: candidate.draw.campaignId,
        status: { in: ["PENDING", "REVIEW", "APPROVED"] },
      },
    });
    if (unresolvedAdjustments > 0) {
      throw new Error("Post-freeze entry cases must be resolved before winner verification");
    }

    if (!candidate.account.entrant.eligibilityAttested) {
      throw new Error("Candidate eligibility attestation is incomplete");
    }
    const campaignEntrant = await tx.campaignEntrant.findUnique({
      where: {
        campaignId_entrantId: {
          campaignId: candidate.draw.campaignId,
          entrantId: candidate.account.entrantId,
        },
      },
    });
    if (!campaignEntrant || campaignEntrant.status !== "ELIGIBLE") {
      throw new Error("Candidate is not eligible for this campaign");
    }
    const now = new Date();
    const changed = await tx.drawCandidate.updateMany({
      where: { id: candidate.id, status: "CONTACTING" },
      data: { status: "VERIFIED", decisionReason: input.reason, verifiedAt: now },
    });
    if (changed.count !== 1) throw new Error("Candidate changed while the decision was recorded; retry");
    const winner = await tx.winner.create({
      data: {
        tenantId: input.tenantId,
        campaignId: candidate.draw.campaignId,
        prizeId: candidate.draw.campaign.prizes[0]!.id,
        entrantId: candidate.account.entrantId,
        drawCandidateId: candidate.id,
        slug: `${candidate.draw.campaign.slug}-winner-${candidate.id.slice(-8).toLowerCase()}`,
        status: "VERIFIED",
        verifiedAt: now,
      },
    });
    await tx.draw.update({ where: { id: candidate.drawId }, data: { status: "WINNER_VERIFIED" } });
    await tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: "ADMIN",
        actorId: input.actorId,
        action: "DRAW_CANDIDATE_VERIFIED",
        resourceType: "Winner",
        resourceId: winner.id,
        reason: input.reason,
        metadataJson: JSON.stringify({ candidateId: candidate.id, rank: candidate.rank, prizeId: winner.prizeId }),
      },
    });
    return { candidate: await tx.drawCandidate.findUniqueOrThrow({ where: { id: candidate.id } }), winner, idempotent: false };
  });
}

export async function publishVerifiedWinner(rawInput: unknown) {
  const input = publicationSchema.parse(rawInput);
  return db.$transaction(async (tx) => {
    await requireRole(tx, { tenantId: input.tenantId, actorId: input.actorId, roles: ["ADMIN"] });
    const winner = await tx.winner.findFirst({
      where: { id: input.winnerId, tenantId: input.tenantId },
      include: { drawCandidate: { include: { draw: true } }, campaign: true },
    });
    if (!winner) throw new Error("Verified winner not found");
    if (winner.status === "PUBLISHED") {
      if (
        winner.publicName !== input.publicName
        || winner.publicLocation !== input.publicLocation
        || (winner.quote ?? "") !== (input.quote ?? "")
      ) {
        throw new Error("Published winner details conflict with this replay");
      }
      return { winner, idempotent: true };
    }
    if (winner.status === "REVOKED") {
      throw new Error("Winner is no longer eligible for this campaign");
    }
    if (winner.status !== "VERIFIED" || !winner.verifiedAt || winner.drawCandidate.status !== "VERIFIED") {
      throw new Error("Winner must complete eligibility verification before publication");
    }
    const [unresolvedAdjustments, campaignEntrant] = await Promise.all([
      tx.entryAdjustmentRequest.count({
        where: {
          tenantId: input.tenantId,
          campaignId: winner.campaignId,
          status: { in: ["PENDING", "REVIEW", "APPROVED"] },
        },
      }),
      tx.campaignEntrant.findUnique({
        where: {
          campaignId_entrantId: {
            campaignId: winner.campaignId,
            entrantId: winner.entrantId,
          },
        },
      }),
    ]);
    if (unresolvedAdjustments > 0) {
      throw new Error("Post-freeze entry cases must be resolved before winner publication");
    }
    if (!campaignEntrant || campaignEntrant.status !== "ELIGIBLE") {
      throw new Error("Winner is no longer eligible for this campaign");
    }
    const now = new Date();
    const changed = await tx.winner.updateMany({
      where: { id: winner.id, status: "VERIFIED" },
      data: {
        status: "PUBLISHED",
        publicName: input.publicName,
        publicLocation: input.publicLocation,
        quote: input.quote || null,
        publishedAt: now,
      },
    });
    if (changed.count !== 1) throw new Error("Winner changed while publication was recorded; retry");
    await tx.draw.update({ where: { id: winner.drawCandidate.drawId }, data: { status: "COMPLETED" } });
    await tx.campaign.update({ where: { id: winner.campaignId }, data: { status: "COMPLETED" } });
    await tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: "ADMIN",
        actorId: input.actorId,
        action: "WINNER_PUBLISHED_WITH_CONSENT",
        resourceType: "Winner",
        resourceId: winner.id,
        metadataJson: JSON.stringify({ publicationConsentConfirmed: true, publishedAt: now.toISOString() }),
      },
    });
    return { winner: await tx.winner.findUniqueOrThrow({ where: { id: winner.id } }), idempotent: false };
  });
}

export async function recordWinnerFulfillment(rawInput: unknown) {
  const input = fulfillmentSchema.parse(rawInput);
  return db.$transaction(async (tx) => {
    await requireRole(tx, { tenantId: input.tenantId, actorId: input.actorId, roles: ["ADMIN", "OPERATIONS"] });
    const winner = await tx.winner.findFirst({ where: { id: input.winnerId, tenantId: input.tenantId } });
    if (!winner || winner.status !== "PUBLISHED") throw new Error("Published winner not found");
    const unresolvedAdjustments = await tx.entryAdjustmentRequest.count({
      where: {
        tenantId: input.tenantId,
        campaignId: winner.campaignId,
        status: { in: ["PENDING", "REVIEW", "APPROVED"] },
      },
    });
    if (unresolvedAdjustments > 0) {
      throw new Error("Entry adjustment incidents must be resolved before winner fulfillment");
    }
    if (winner.fulfilledAt) return { winner, idempotent: true };
    const now = new Date();
    const changed = await tx.winner.updateMany({
      where: { id: winner.id, status: "PUBLISHED", fulfilledAt: null },
      data: { fulfilledAt: now },
    });
    if (changed.count !== 1) throw new Error("Winner changed while fulfillment was recorded; retry");
    await tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: "ADMIN",
        actorId: input.actorId,
        action: "WINNER_FULFILLMENT_RECORDED",
        resourceType: "Winner",
        resourceId: winner.id,
        metadataJson: JSON.stringify({ evidenceReference: input.evidenceReference, fulfilledAt: now.toISOString() }),
      },
    });
    return { winner: await tx.winner.findUniqueOrThrow({ where: { id: winner.id } }), idempotent: false };
  });
}
