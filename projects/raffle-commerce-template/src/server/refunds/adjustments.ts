import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/server/db";

const id = z.string().trim().min(1).max(191);
const notes = z.string().trim().min(10).max(1_000);
const evidence = z.string().trim().min(5).max(500);

const evidenceApprovalSchema = z.object({
  tenantId: id,
  requestId: id,
  actorId: id,
  evidenceRef: evidence,
  notes,
}).strict();

export const adjustmentDispositionSchema = z.enum([
  "REVERSE_BEFORE_DRAW",
  "APPLY_BEFORE_DRAW",
  "VOID_DRAW_AND_REBUILD",
  "PRESERVE_RESULT",
  "DISQUALIFY_ENTRANT",
]);

const complianceDecisionSchema = z.object({
  tenantId: id,
  requestId: id,
  actorId: id,
  disposition: adjustmentDispositionSchema,
  notes,
}).strict();

export type EntryAdjustmentDisposition = z.infer<typeof adjustmentDispositionSchema>;

const unresolvedAdjustmentStatuses = ["PENDING", "REVIEW", "APPROVED"];

function prismaErrorCode(error: unknown) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function requireAdjustmentRole(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; actorId: string; roles: readonly string[] },
) {
  const user = await tx.user.findFirst({
    where: {
      id: input.actorId,
      tenantId: input.tenantId,
      status: "ACTIVE",
      role: { in: [...input.roles] },
    },
    select: { id: true, role: true },
  });
  if (!user) throw new Error("The authenticated operator is not authorized for this adjustment step");
  return user;
}

async function loadRequest(tx: Prisma.TransactionClient, tenantId: string, requestId: string) {
  const request = await tx.entryAdjustmentRequest.findFirst({
    where: { id: requestId, tenantId },
    include: {
      account: { select: { id: true, entrantId: true, balance: true } },
      approvals: { orderBy: { createdAt: "asc" } },
      campaign: {
        select: {
          id: true,
          status: true,
          configChecksum: true,
          maxEntriesPerEntrant: true,
          snapshots: {
            where: { status: { in: ["AWAITING_APPROVAL", "SEALED"] } },
            select: { id: true, version: true, status: true },
            orderBy: { version: "desc" },
          },
          draws: {
            select: {
              id: true,
              snapshotId: true,
              status: true,
              candidates: {
                select: {
                  id: true,
                  entryAccountId: true,
                  rank: true,
                  status: true,
                  winner: {
                    select: {
                      id: true,
                      entrantId: true,
                      status: true,
                      publishedAt: true,
                      fulfilledAt: true,
                    },
                  },
                },
                orderBy: { rank: "asc" },
              },
            },
            orderBy: { createdAt: "desc" },
          },
        },
      },
      refund: {
        include: {
          order: {
            select: {
              id: true,
              tenantId: true,
              campaignId: true,
              entrantId: true,
              orderNumber: true,
            },
          },
          allocations: {
            include: {
              orderLine: {
                include: {
                  entitlements: {
                    where: { status: "POSTED" },
                    include: { ledgerEvents: true },
                  },
                },
              },
            },
            orderBy: { id: "asc" },
          },
        },
      },
      subscriptionCycle: {
        include: {
          subscription: {
            select: { id: true, tenantId: true, entrantId: true },
          },
          order: {
            include: {
              lines: {
                select: {
                  id: true,
                  entries: true,
                  entryCalculationJson: true,
                },
                orderBy: { id: "asc" },
              },
            },
          },
        },
      },
    },
  });
  if (!request) throw new Error("Tenant adjustment case not found");
  if (Number(Boolean(request.refund)) + Number(Boolean(request.subscriptionCycle)) !== 1) {
    throw new Error("Adjustment case must have exactly one immutable source");
  }
  if (request.refund && (
    request.refund.tenantId !== tenantId
    || request.refund.order.tenantId !== tenantId
    || request.refund.order.campaignId !== request.campaignId
    || request.refund.order.entrantId !== request.account.entrantId
    || request.delta >= 0n
  )) throw new Error("Refund adjustment does not belong to one tenant campaign entrant");
  if (request.subscriptionCycle && (
    request.subscriptionCycle.subscription.tenantId !== tenantId
    || request.subscriptionCycle.subscription.entrantId !== request.account.entrantId
    || request.subscriptionCycle.order.tenantId !== tenantId
    || request.subscriptionCycle.order.campaignId !== request.campaignId
    || request.subscriptionCycle.order.entrantId !== request.account.entrantId
    || request.delta <= 0n
  )) throw new Error("Subscription adjustment does not belong to one tenant campaign entrant");
  return request;
}

function exactEvidenceReplay(
  approval: { approverId: string; evidenceRef: string | null; notes: string },
  input: z.infer<typeof evidenceApprovalSchema>,
) {
  if (
    approval.approverId !== input.actorId
    || approval.evidenceRef !== input.evidenceRef
    || approval.notes !== input.notes
  ) {
    throw new Error("Evidence approval conflicts with the immutable recorded approval");
  }
}

function exactDecisionReplay(
  approval: { approverId: string; disposition: string | null; notes: string },
  input: z.infer<typeof complianceDecisionSchema>,
) {
  if (
    approval.approverId !== input.actorId
    || approval.disposition !== input.disposition
    || approval.notes !== input.notes
  ) {
    throw new Error("Compliance decision conflicts with the immutable recorded decision");
  }
}

/**
 * First half of the adjustment quorum. The evidence record is inserted once
 * and is never updated; the request state advances with a compare-and-swap.
 */
export async function approveAdjustmentEvidence(rawInput: unknown) {
  const input = evidenceApprovalSchema.parse(rawInput);
  try {
    return await db.$transaction(async (tx) => {
      const actor = await requireAdjustmentRole(tx, {
        tenantId: input.tenantId,
        actorId: input.actorId,
        roles: ["ADMIN", "OPERATIONS"],
      });
      const request = await loadRequest(tx, input.tenantId, input.requestId);
      const existing = request.approvals.find((approval) => approval.kind === "EVIDENCE_REVIEW");
      if (existing) {
        exactEvidenceReplay(existing, input);
        return { request, approval: existing, idempotent: true };
      }
      if (request.status !== "PENDING") throw new Error("Adjustment case is not awaiting evidence review");

      const approval = await tx.entryAdjustmentApproval.create({
        data: {
          tenantId: input.tenantId,
          requestId: request.id,
          kind: "EVIDENCE_REVIEW",
          approverId: actor.id,
          approverRole: actor.role,
          evidenceRef: input.evidenceRef,
          notes: input.notes,
        },
      });
      const advanced = await tx.entryAdjustmentRequest.updateMany({
        where: { id: request.id, tenantId: input.tenantId, status: "PENDING" },
        data: { status: "REVIEW" },
      });
      if (advanced.count !== 1) throw new Error("Adjustment case changed during evidence approval; retry");
      await tx.auditEvent.create({
        data: {
          tenantId: input.tenantId,
          actorType: "ADMIN",
          actorId: actor.id,
          action: "ENTRY_ADJUSTMENT_EVIDENCE_APPROVED",
          resourceType: "EntryAdjustmentRequest",
          resourceId: request.id,
          reason: input.notes,
          metadataJson: JSON.stringify({
            evidenceRef: input.evidenceRef,
            refundId: request.refundId,
            subscriptionCycleId: request.subscriptionCycleId,
          }),
        },
      });
      return {
        request: await tx.entryAdjustmentRequest.findUniqueOrThrow({ where: { id: request.id } }),
        approval,
        idempotent: false,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (prismaErrorCode(error) !== "P2002") throw error;
    const existing = await db.entryAdjustmentApproval.findFirst({
      where: { requestId: input.requestId, request: { tenantId: input.tenantId }, kind: "EVIDENCE_REVIEW" },
    });
    if (!existing) throw error;
    exactEvidenceReplay(existing, input);
    return {
      request: await db.entryAdjustmentRequest.findFirstOrThrow({
        where: { id: input.requestId, tenantId: input.tenantId },
      }),
      approval: existing,
      idempotent: true,
    };
  }
}

/** Completes the distinct-person quorum without rewriting frozen evidence. */
export async function decideAdjustmentCompliance(rawInput: unknown) {
  const input = complianceDecisionSchema.parse(rawInput);
  try {
    return await db.$transaction(async (tx) => {
      const actor = await requireAdjustmentRole(tx, {
        tenantId: input.tenantId,
        actorId: input.actorId,
        roles: ["COMPLIANCE"],
      });
      const request = await loadRequest(tx, input.tenantId, input.requestId);
      const refund = request.refund;
      const subscriptionCycle = request.subscriptionCycle;
      const existing = request.approvals.find((approval) => approval.kind === "COMPLIANCE_DECISION");
      if (existing) {
        exactDecisionReplay(existing, input);
        return { request, approval: existing, idempotent: true };
      }
      const evidenceApproval = request.approvals.find((approval) => approval.kind === "EVIDENCE_REVIEW");
      if (!evidenceApproval) throw new Error("Operations evidence approval is required before compliance decision");
      if (evidenceApproval.approverId === actor.id) {
        throw new Error("Evidence review and compliance decision require different people");
      }
      if (request.status !== "REVIEW") throw new Error("Adjustment case is not awaiting compliance decision");

      const activeDraws = request.campaign.draws.filter((draw) => !["VOID", "CANCELLED"].includes(draw.status));
      const hasActiveDraw = activeDraws.length > 0;
      const isPositiveGrant = request.delta > 0n;
      if (!hasActiveDraw) {
        const required = isPositiveGrant ? "APPLY_BEFORE_DRAW" : "REVERSE_BEFORE_DRAW";
        if (input.disposition !== required) {
          throw new Error(`This pre-draw case requires the ${required} disposition`);
        }
      } else if (isPositiveGrant) {
        if (input.disposition !== "VOID_DRAW_AND_REBUILD") {
          throw new Error("A late positive grant after selection requires an explicit void-draw-and-rebuild disposition");
        }
        const publishedOrFulfilled = activeDraws.some((draw) => draw.candidates.some((candidate) => (
          Boolean(candidate.winner?.publishedAt)
          || Boolean(candidate.winner?.fulfilledAt)
          || candidate.winner?.status === "PUBLISHED"
        )));
        if (publishedOrFulfilled) {
          throw new Error("A published or fulfilled winner requires an unresolved external-remedy incident");
        }
      } else if (!["PRESERVE_RESULT", "DISQUALIFY_ENTRANT"].includes(input.disposition)) {
        throw new Error("A post-draw refund requires an explicit preservation or disqualification disposition");
      }

      if (!isPositiveGrant && input.disposition === "DISQUALIFY_ENTRANT") {
        const fulfilledWinner = activeDraws.some((draw) => draw.candidates.some((candidate) => (
          candidate.entryAccountId === request.entryAccountId && Boolean(candidate.winner?.fulfilledAt)
        )));
        if (fulfilledWinner) {
          throw new Error("A fulfilled winner requires an unresolved external-remedy incident");
        }
      }

      const approval = await tx.entryAdjustmentApproval.create({
        data: {
          tenantId: input.tenantId,
          requestId: request.id,
          kind: "COMPLIANCE_DECISION",
          approverId: actor.id,
          approverRole: actor.role,
          notes: input.notes,
          disposition: input.disposition,
        },
      });

      let ledgerEventId: string | null = null;
      let finalStatus: "APPLIED" | "RESOLVED";
      const now = new Date();
      if (!hasActiveDraw || isPositiveGrant) {
        const voidedDrawIds = isPositiveGrant ? activeDraws.map((draw) => draw.id) : [];
        if (voidedDrawIds.length) {
          await tx.winner.updateMany({
            where: {
              drawCandidate: { drawId: { in: voidedDrawIds } },
              publishedAt: null,
              fulfilledAt: null,
            },
            data: { status: "VOID" },
          });
          await tx.drawCandidate.updateMany({
            where: { drawId: { in: voidedDrawIds } },
            data: { status: "VOID" },
          });
          await tx.draw.updateMany({
            where: { id: { in: voidedDrawIds } },
            data: { status: "VOID" },
          });
        }
        await tx.entrySnapshot.updateMany({
          where: {
            tenantId: input.tenantId,
            campaignId: request.campaignId,
            status: { in: ["AWAITING_APPROVAL", "SEALED"] },
          },
          data: { status: "VOID" },
        });
        if (request.campaign.status !== "RECONCILING") {
          const campaignClaim = await tx.campaign.updateMany({
            where: {
              id: request.campaignId,
              tenantId: input.tenantId,
              status: request.campaign.status,
            },
            data: { status: "RECONCILING" },
          });
          if (campaignClaim.count !== 1) throw new Error("Campaign changed during adjustment application; retry");
        }

        if (isPositiveGrant) {
          if (!subscriptionCycle) throw new Error("Late subscription cycle evidence is unavailable");
          if (
            request.campaign.maxEntriesPerEntrant != null
            && request.account.balance + request.delta > request.campaign.maxEntriesPerEntrant
          ) {
            throw new Error("Late subscription grant would exceed the campaign entrant cap at application time");
          }
          const orderLine = subscriptionCycle.order.lines[0];
          if (!orderLine || subscriptionCycle.order.lines.length !== 1) {
            throw new Error("Late subscription order must contain one immutable membership line");
          }
          if (subscriptionCycle.order.entryTotal !== 0n || orderLine.entries !== 0n) {
            throw new Error("Late subscription order already claims posted entries");
          }
          const entitlement = await tx.entryEntitlement.create({
            data: {
              tenantId: input.tenantId,
              entryAccountId: request.entryAccountId,
              orderId: subscriptionCycle.orderId,
              orderLineId: orderLine.id,
              originType: "SUBSCRIPTION_CYCLE_ADJUSTMENT",
              status: "POSTED",
              originalEntries: request.delta,
              calculationJson: orderLine.entryCalculationJson,
              campaignConfigHash: request.campaign.configChecksum,
              idempotencyKey: `adjustment-entitlement:${request.id}`,
              effectiveAt: subscriptionCycle.settledAt ?? now,
            },
          });
          const ledgerEvent = await tx.entryLedgerEvent.create({
            data: {
              tenantId: input.tenantId,
              entryAccountId: request.entryAccountId,
              entitlementId: entitlement.id,
              kind: "GRANT",
              delta: request.delta,
              idempotencyKey: `adjustment-grant:${request.id}`,
              effectiveAt: subscriptionCycle.settledAt ?? now,
              actorType: "ADMIN",
              actorId: actor.id,
              reasonCode: "APPROVED_LATE_SUBSCRIPTION_GRANT",
              metadataJson: JSON.stringify({
                adjustmentRequestId: request.id,
                subscriptionCycleId: subscriptionCycle.id,
                orderId: subscriptionCycle.orderId,
                disposition: input.disposition,
              }),
            },
          });
          ledgerEventId = ledgerEvent.id;
          const balanceClaim = await tx.entryAccount.updateMany({
            where: {
              id: request.entryAccountId,
              tenantId: input.tenantId,
              campaignId: request.campaignId,
              balance: request.account.balance,
            },
            data: { balance: { increment: request.delta }, version: { increment: 1 } },
          });
          if (balanceClaim.count !== 1) throw new Error("Entry account changed during adjustment application; retry");
          const [orderClaim, lineClaim] = await Promise.all([
            tx.order.updateMany({
              where: { id: subscriptionCycle.orderId, tenantId: input.tenantId, entryTotal: 0n },
              data: { entryTotal: request.delta },
            }),
            tx.orderLine.updateMany({
              where: { id: orderLine.id, orderId: subscriptionCycle.orderId, entries: 0n },
              data: { entries: request.delta },
            }),
          ]);
          if (orderClaim.count !== 1 || lineClaim.count !== 1) {
            throw new Error("Late subscription entry posting changed during adjustment application; retry");
          }
        } else {
          if (!refund) throw new Error("Refund adjustment evidence is unavailable");
          let reversalTotal = 0n;
          for (const allocation of refund.allocations) {
            if (allocation.entriesReversed <= 0n) continue;
            const entitlement = allocation.orderLine.entitlements[0];
            if (!entitlement || entitlement.entryAccountId !== request.entryAccountId) {
              throw new Error(`Entry entitlement missing for refunded line ${allocation.orderLineId}`);
            }
            const originalGrant = entitlement.ledgerEvents.find((event) => event.kind === "GRANT");
            const ledgerEvent = await tx.entryLedgerEvent.create({
              data: {
                tenantId: input.tenantId,
                entryAccountId: request.entryAccountId,
                entitlementId: entitlement.id,
                kind: "REVERSAL",
                delta: -allocation.entriesReversed,
                reversesEventId: originalGrant?.id,
                idempotencyKey: `adjustment:${request.id}:${allocation.orderLineId}`,
                effectiveAt: refund.processedAt ?? now,
                actorType: "ADMIN",
                actorId: actor.id,
                reasonCode: "APPROVED_POST_FREEZE_REFUND_REVERSAL",
                metadataJson: JSON.stringify({
                  adjustmentRequestId: request.id,
                  refundId: request.refundId,
                  amountCents: allocation.amountCents,
                  disposition: input.disposition,
                }),
              },
            });
            ledgerEventId ??= ledgerEvent.id;
            reversalTotal += allocation.entriesReversed;
          }
          if (reversalTotal !== -request.delta) {
            throw new Error("Adjustment allocations do not match the requested entry consequence");
          }
          const balanceClaim = await tx.entryAccount.updateMany({
            where: {
              id: request.entryAccountId,
              tenantId: input.tenantId,
              campaignId: request.campaignId,
              balance: { gte: reversalTotal },
            },
            data: { balance: { decrement: reversalTotal }, version: { increment: 1 } },
          });
          if (balanceClaim.count !== 1) throw new Error("Adjustment reversal would make the entry balance negative");
        }
        finalStatus = "APPLIED";
      } else {
        if (input.disposition === "DISQUALIFY_ENTRANT") {
          const disqualified = await tx.campaignEntrant.updateMany({
            where: { campaignId: request.campaignId, entrantId: request.account.entrantId },
            data: {
              status: "DISQUALIFIED",
              flaggedAt: now,
              reviewedAt: now,
              reviewReason: input.notes,
            },
          });
          if (disqualified.count !== 1) throw new Error("Campaign entrant record is unavailable for disqualification");

          const selected = activeDraws
            .flatMap((draw) => draw.candidates.map((candidate) => ({ draw, candidate })))
            .find(({ candidate }) => candidate.entryAccountId === request.entryAccountId);
          if (selected) {
            if (selected.candidate.winner) {
              await tx.winner.update({
                where: { id: selected.candidate.winner.id },
                data: { status: "REVOKED" },
              });
            }
            await tx.drawCandidate.update({
              where: { id: selected.candidate.id },
              data: {
                status: "DISQUALIFIED",
                verifiedAt: null,
                decisionReason: input.notes,
              },
            });
            const next = selected.draw.candidates.find((candidate) => (
              candidate.rank > selected.candidate.rank && candidate.status === "ALTERNATE"
            ));
            if (next) {
              await tx.drawCandidate.update({
                where: { id: next.id },
                data: { status: "CONTACTING" },
              });
            }
            await tx.draw.update({
              where: { id: selected.draw.id },
              data: { status: next ? "VERIFYING" : "EXHAUSTED" },
            });
            await tx.campaign.update({
              where: { id: request.campaignId },
              data: { status: "WINNER_PENDING" },
            });
            await tx.auditEvent.create({
              data: {
                tenantId: input.tenantId,
                actorType: "ADMIN",
                actorId: actor.id,
                action: "WINNER_REVOKED_FOR_ENTRY_ADJUSTMENT",
                resourceType: "DrawCandidate",
                resourceId: selected.candidate.id,
                reason: input.notes,
                metadataJson: JSON.stringify({
                  adjustmentRequestId: request.id,
                  winnerId: selected.candidate.winner?.id ?? null,
                  nextCandidateId: next?.id ?? null,
                }),
              },
            });
          }
        }
        finalStatus = "RESOLVED";
      }

      const resolved = await tx.entryAdjustmentRequest.updateMany({
        where: { id: request.id, tenantId: input.tenantId, status: "REVIEW" },
        data: {
          status: finalStatus,
          reviewedBy: actor.id,
          decisionNotes: input.notes,
          disposition: input.disposition,
          decidedAt: now,
          appliedAt: now,
          ledgerEventId,
        },
      });
      if (resolved.count !== 1) throw new Error("Adjustment case changed during compliance decision; retry");
      await tx.auditEvent.create({
        data: {
          tenantId: input.tenantId,
          actorType: "ADMIN",
          actorId: actor.id,
          action: finalStatus === "APPLIED" ? "ENTRY_ADJUSTMENT_APPLIED" : "ENTRY_ADJUSTMENT_DISPOSITION_RECORDED",
          resourceType: "EntryAdjustmentRequest",
          resourceId: request.id,
          reason: input.notes,
          metadataJson: JSON.stringify({
            disposition: input.disposition,
            refundId: request.refundId,
            subscriptionCycleId: request.subscriptionCycleId,
            voidedSnapshotIds: (!hasActiveDraw || isPositiveGrant)
              ? request.campaign.snapshots.map((snapshot) => snapshot.id)
              : [],
            voidedDrawIds: isPositiveGrant ? activeDraws.map((draw) => draw.id) : [],
            historicalRecordsPreserved: true,
          }),
        },
      });
      return {
        request: await tx.entryAdjustmentRequest.findUniqueOrThrow({ where: { id: request.id } }),
        approval,
        idempotent: false,
      };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000,
      timeout: 15_000,
    });
  } catch (error) {
    if (prismaErrorCode(error) !== "P2002") throw error;
    const existing = await db.entryAdjustmentApproval.findFirst({
      where: { requestId: input.requestId, request: { tenantId: input.tenantId }, kind: "COMPLIANCE_DECISION" },
    });
    if (!existing) throw error;
    exactDecisionReplay(existing, input);
    return {
      request: await db.entryAdjustmentRequest.findFirstOrThrow({
        where: { id: input.requestId, tenantId: input.tenantId },
      }),
      approval: existing,
      idempotent: true,
    };
  }
}

export async function countUnresolvedAdjustments(input: {
  tenantId: string;
  campaignId: string;
  entryAccountId?: string;
}) {
  return db.entryAdjustmentRequest.count({
    where: {
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      entryAccountId: input.entryAccountId,
      status: { in: unresolvedAdjustmentStatuses },
    },
  });
}
