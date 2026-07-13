import "server-only";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/server/db";
import { assertCampaignReleaseIntegrity } from "@/server/campaigns/integrity";
import { selectCandidates } from "./random";

const snapshotApprovalKinds = ["OPERATIONS_RECONCILIATION", "COMPLIANCE_WITNESS"] as const;
type SnapshotApprovalKind = (typeof snapshotApprovalKinds)[number];

function prismaErrorCode(error: unknown) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalSnapshotCsv(rows: Array<{ accountId: string; entrantId: string; entryCount: bigint; rangeStart: bigint; rangeEnd: bigint }>) {
  const lines = ["entry_account_id,entrant_id,entry_count,range_start,range_end"];
  for (const row of rows) {
    lines.push([row.accountId, row.entrantId, row.entryCount, row.rangeStart, row.rangeEnd].join(","));
  }
  return `${lines.join("\n")}\n`;
}

async function requireDrawStaff(
  client: Prisma.TransactionClient | typeof db,
  input: { userId: string; tenantId: string; roles: readonly string[] },
) {
  const user = await client.user.findFirst({
    where: { id: input.userId, tenantId: input.tenantId, status: "ACTIVE" },
    select: { id: true, role: true },
  });
  if (!user || !input.roles.includes(user.role.toUpperCase())) {
    throw new Error("The authenticated operator is not authorized for this draw step");
  }
  return user;
}

async function calculateSnapshotRows(client: Prisma.TransactionClient | typeof db, campaignId: string) {
  const accounts = await client.entryAccount.findMany({
    where: { campaignId },
    include: {
      entrant: {
        select: {
          id: true,
          campaigns: { where: { campaignId }, select: { status: true }, take: 1 },
        },
      },
    },
    orderBy: { id: "asc" },
  });
  const ledgerSums = accounts.length
    ? await client.entryLedgerEvent.groupBy({
        by: ["entryAccountId"],
        where: { entryAccountId: { in: accounts.map((account) => account.id) } },
        _sum: { delta: true },
      })
    : [];
  const sums = new Map(ledgerSums.map((item) => [item.entryAccountId, item._sum.delta ?? 0n]));
  for (const account of accounts) {
    if ((sums.get(account.id) ?? 0n) !== account.balance) {
      throw new Error(`Entry account ${account.id} does not reconcile to its append-only ledger`);
    }
  }

  let cursor = 1n;
  const rows = accounts
    .filter((account) => (
      account.balance > 0n
      && ["ELIGIBLE", "VERIFIED"].includes(account.entrant.campaigns[0]?.status ?? "")
    ))
    .map((account) => {
      const rangeStart = cursor;
      const rangeEnd = cursor + account.balance - 1n;
      cursor = rangeEnd + 1n;
      return {
        accountId: account.id,
        entrantId: account.entrant.id,
        entryCount: account.balance,
        rangeStart,
        rangeEnd,
      };
    });
  return { rows, totalEntries: cursor - 1n, canonicalCsv: canonicalSnapshotCsv(rows) };
}

function verifyPersistedSnapshot(input: {
  checksum: string;
  totalEntries: bigint;
  entrantCount: number;
  rows: Array<{
    entryAccountId: string;
    entryCount: bigint;
    rangeStart: bigint;
    rangeEnd: bigint;
    account: { entrantId: string };
  }>;
}) {
  let cursor = 1n;
  const accountIds = new Set<string>();
  for (const row of input.rows) {
    if (accountIds.has(row.entryAccountId)) throw new Error("Snapshot contains a duplicate entry account");
    accountIds.add(row.entryAccountId);
    if (row.rangeStart !== cursor || row.rangeEnd < row.rangeStart) {
      throw new Error("Snapshot entry ranges are not canonical and contiguous");
    }
    if (row.entryCount !== row.rangeEnd - row.rangeStart + 1n) {
      throw new Error("Snapshot row count does not match its selected-entry range");
    }
    cursor = row.rangeEnd + 1n;
  }
  const totalEntries = cursor - 1n;
  if (input.rows.length !== input.entrantCount || totalEntries !== input.totalEntries) {
    throw new Error("Snapshot header totals do not match its immutable rows");
  }
  const canonicalCsv = canonicalSnapshotCsv(input.rows.map((row) => ({
    accountId: row.entryAccountId,
    entrantId: row.account.entrantId,
    entryCount: row.entryCount,
    rangeStart: row.rangeStart,
    rangeEnd: row.rangeEnd,
  })));
  if (sha256(canonicalCsv) !== input.checksum) {
    throw new Error("Snapshot canonical checksum does not match its immutable rows");
  }
  return { canonicalCsv, totalEntries };
}

function encryptDemoSeed(seed: Uint8Array) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be set before conducting a draw");
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export async function buildEntrySnapshot(campaignId: string, actorId: string) {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new Error("Campaign not found");
  if (!["ENTRY_CLOSED", "RECONCILING", "LIVE"].includes(campaign.status)) {
    throw new Error(`Campaign cannot be snapshotted from ${campaign.status}`);
  }
  const latestEntryCutoff = campaign.freeEntryEndsAt > campaign.endsAt
    ? campaign.freeEntryEndsAt
    : campaign.endsAt;
  if (new Date() < latestEntryCutoff) throw new Error("Campaign entry period is still open");
  await requireDrawStaff(db, { userId: actorId, tenantId: campaign.tenantId, roles: ["ADMIN", "OPERATIONS"] });
  return db.$transaction(async (tx) => {
    await assertCampaignReleaseIntegrity(tx, campaignId);
    // Freeze application-level ledger writers before reading the final state.
    // Production migrations mirror this with a database trigger so a refund or
    // review racing this transaction fails instead of changing approved rows.
    const freeze = await tx.campaign.updateMany({
      where: { id: campaignId, tenantId: campaign.tenantId, status: campaign.status },
      data: { status: "SNAPSHOT_REVIEW" },
    });
    if (freeze.count !== 1) throw new Error("Campaign changed while snapshot reconciliation began; retry");

    const unresolved = await Promise.all([
      tx.freeEntrySubmission.count({ where: { campaignId, status: { in: ["PENDING", "REVIEW"] } } }),
      tx.order.count({ where: { campaignId, paymentStatus: { in: ["UNPAID", "PENDING", "PROCESSING"] } } }),
      tx.refund.count({ where: { order: { campaignId }, status: { in: ["PENDING", "PROCESSING"] } } }),
      tx.entryAdjustmentRequest.count({ where: { campaignId, status: { in: ["PENDING", "REVIEW", "APPROVED"] } } }),
      tx.subscriptionCycle.count({
        where: { order: { campaignId }, status: { not: "SETTLED" } },
      }),
      tx.webhookEvent.count({
        where: {
          tenantId: campaign.tenantId,
          provider: "STRIPE",
          eventType: { in: ["invoice.paid", "invoice_payment.paid"] },
          status: { in: ["RECEIVED", "PROCESSING", "FAILED"] },
        },
      }),
    ]);
    if (unresolved.some((count) => count > 0)) {
      throw new Error(`Campaign reconciliation is incomplete (${unresolved.join("/")} unresolved queues)`);
    }

    const { rows, totalEntries, canonicalCsv } = await calculateSnapshotRows(tx, campaignId);
    if (!rows.length) throw new Error("Campaign has no eligible entries");
    const checksum = sha256(canonicalCsv);
    const previous = await tx.entrySnapshot.aggregate({ where: { campaignId }, _max: { version: true } });
    const version = (previous._max.version ?? 0) + 1;
    const now = new Date();
    const draft = await tx.entrySnapshot.create({
      data: {
        tenantId: campaign.tenantId,
        campaignId,
        version,
        status: "DRAFT",
        cutoffAt: latestEntryCutoff,
        ledgerHighWaterAt: now,
        totalEntries,
        entrantCount: rows.length,
        checksum,
      },
    });
    await tx.entrySnapshotRow.createMany({
      data: rows.map((row) => ({
        snapshotId: draft.id,
        entryAccountId: row.accountId,
        entryCount: row.entryCount,
        rangeStart: row.rangeStart,
        rangeEnd: row.rangeEnd,
      })),
    });
    await tx.snapshotApproval.createMany({
      data: snapshotApprovalKinds.map((kind) => ({ snapshotId: draft.id, kind, status: "PENDING" })),
    });
    const created = await tx.entrySnapshot.update({
      where: { id: draft.id },
      data: { status: "AWAITING_APPROVAL" },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: campaign.tenantId,
        actorType: "ADMIN",
        actorId,
        action: "ENTRY_SNAPSHOT_BUILT",
        resourceType: "EntrySnapshot",
        resourceId: created.id,
        metadataJson: JSON.stringify({ checksum, totalEntries: totalEntries.toString(), entrantCount: rows.length, version }),
      },
    });
    return { snapshot: created, canonicalCsv };
  });
}

/** Records one side of a two-person snapshot approval and seals on quorum. */
export async function approveEntrySnapshot(input: {
  snapshotId: string;
  actorId: string;
  kind: SnapshotApprovalKind;
  notes: string;
}) {
  if (!snapshotApprovalKinds.includes(input.kind)) throw new Error("Unsupported snapshot approval kind");
  if (input.notes.trim().length < 5 || input.notes.trim().length > 500) {
    throw new Error("Approval notes must contain 5 to 500 characters");
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        const snapshot = await tx.entrySnapshot.findUnique({
      where: { id: input.snapshotId },
      include: {
        campaign: true,
        approvals: true,
        rows: { include: { account: { select: { entrantId: true } } }, orderBy: { rangeStart: "asc" } },
      },
    });
        if (!snapshot) throw new Error("Snapshot is not awaiting approval");
        const roles = input.kind === "OPERATIONS_RECONCILIATION"
          ? ["ADMIN", "OPERATIONS"]
          : ["COMPLIANCE"];
        await requireDrawStaff(tx, { userId: input.actorId, tenantId: snapshot.tenantId, roles });
        verifyPersistedSnapshot(snapshot);

        const approval = snapshot.approvals.find((item) => item.kind === input.kind);
        if (!approval) throw new Error("Required approval record is missing");
        if (snapshot.status === "SEALED") {
          if (approval.status !== "APPROVED" || approval.approverId !== input.actorId) {
            throw new Error("Snapshot was sealed with a different approval identity");
          }
          return { snapshot, sealed: true, idempotent: true };
        }
        if (snapshot.status !== "AWAITING_APPROVAL") {
          throw new Error("Snapshot is not awaiting approval");
        }
        if (snapshot.campaign.status !== "SNAPSHOT_REVIEW") {
          throw new Error("Campaign is not frozen for snapshot review");
        }
        await assertCampaignReleaseIntegrity(tx, snapshot.campaignId);

        const idempotent = approval.status === "APPROVED";
        if (idempotent && approval.approverId !== input.actorId) {
          throw new Error("Approval was already completed by another operator");
        }
        const otherApproval = snapshot.approvals.find((item) => item.kind !== input.kind && item.status === "APPROVED");
        if (otherApproval?.approverId === input.actorId) {
          throw new Error("Snapshot reconciliation and compliance approval require different people");
        }

        if (!idempotent) {
          const decidedAt = new Date();
          const claimed = await tx.snapshotApproval.updateMany({
            where: { id: approval.id, status: "PENDING", approverId: null },
            data: {
              status: "APPROVED",
              approverId: input.actorId,
              notes: input.notes.trim(),
              decidedAt,
            },
          });
          if (claimed.count !== 1) {
            throw new Error("Snapshot approval changed concurrently; retry");
          }
          await tx.auditEvent.create({
            data: {
              tenantId: snapshot.tenantId,
              actorType: "ADMIN",
              actorId: input.actorId,
              action: "ENTRY_SNAPSHOT_APPROVED",
              resourceType: "EntrySnapshot",
              resourceId: snapshot.id,
              reason: input.notes.trim(),
              metadataJson: JSON.stringify({ kind: input.kind, checksum: snapshot.checksum }),
            },
          });
        }

        // Always re-read quorum after the write. This also lets an idempotent
        // replay finish sealing if two distinct approvals previously committed
        // without either caller observing the other.
        const currentApprovals = await tx.snapshotApproval.findMany({
          where: { snapshotId: snapshot.id },
          orderBy: { kind: "asc" },
        });
        const approved = currentApprovals.filter((item) => item.status === "APPROVED");
        if (approved.length < snapshotApprovalKinds.length) {
          return { snapshot, sealed: false, idempotent };
        }
        if (
          approved.some((item) => !item.approverId)
          || new Set(approved.map((item) => item.approverId)).size !== snapshotApprovalKinds.length
        ) {
          throw new Error("Snapshot reconciliation and compliance approval require different people");
        }

        const recalculated = await calculateSnapshotRows(tx, snapshot.campaignId);
        if (
          sha256(recalculated.canonicalCsv) !== snapshot.checksum
          || recalculated.totalEntries !== snapshot.totalEntries
          || recalculated.canonicalCsv !== verifyPersistedSnapshot(snapshot).canonicalCsv
        ) {
          throw new Error("Entry ledger changed after snapshot construction; rebuild and reapprove the snapshot");
        }
        const sealedAt = new Date();
        const sealClaim = await tx.entrySnapshot.updateMany({
          where: { id: snapshot.id, status: "AWAITING_APPROVAL", sealedAt: null },
          data: { status: "SEALED", sealedAt, sealedBy: input.actorId },
        });
        if (sealClaim.count !== 1) throw new Error("Snapshot sealing changed concurrently; retry");
        const campaignClaim = await tx.campaign.updateMany({
          where: { id: snapshot.campaignId, status: "SNAPSHOT_REVIEW" },
          data: { status: "SEALED" },
        });
        if (campaignClaim.count !== 1) throw new Error("Campaign changed during snapshot sealing; retry");
        const sealed = await tx.entrySnapshot.findUniqueOrThrow({ where: { id: snapshot.id } });
        await tx.auditEvent.create({
          data: {
            tenantId: snapshot.tenantId,
            actorType: "SYSTEM",
            actorId: input.actorId,
            action: "ENTRY_SNAPSHOT_SEALED",
            resourceType: "EntrySnapshot",
            resourceId: snapshot.id,
            metadataJson: JSON.stringify({ checksum: snapshot.checksum, totalEntries: snapshot.totalEntries.toString() }),
          },
        });
        return { snapshot: sealed, sealed: true, idempotent };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (attempt < 2 && ["P1008", "P2028", "P2034"].includes(prismaErrorCode(error) ?? "")) continue;
      throw error;
    }
  }
  throw new Error("Snapshot approval exhausted its serialization retries");
}

export async function conductDemoDraw(snapshotId: string, operatorId: string, candidateCount = 5) {
  if (process.env.DEMO_MODE !== "true") {
    throw new Error("Internal draw execution is disabled outside demo mode; use an independent draw administrator");
  }
  if (!Number.isSafeInteger(candidateCount) || candidateCount < 1 || candidateCount > 10) {
    throw new Error("Candidate count must be an integer from 1 to 10");
  }
  try {
    return await db.$transaction(async (tx) => {
      const snapshot = await tx.entrySnapshot.findUnique({
        where: { id: snapshotId },
        include: {
          campaign: true,
          rows: { include: { account: { select: { entrantId: true } } }, orderBy: { rangeStart: "asc" } },
          draws: { select: { id: true } },
          approvals: true,
        },
      });
      if (!snapshot || snapshot.status !== "SEALED" || !snapshot.sealedAt) throw new Error("A sealed snapshot is required");
      if (snapshot.campaign.drawAt && new Date() < snapshot.campaign.drawAt) throw new Error("The scheduled draw time has not arrived");
      // A snapshot is single-use, including when its historical draw was later
      // voided. A replacement draw requires a freshly reconciled snapshot.
      if (snapshot.draws.length > 0) throw new Error("This snapshot already has a draw");
      await assertCampaignReleaseIntegrity(tx, snapshot.campaignId);
      const persisted = verifyPersistedSnapshot(snapshot);
      const recalculated = await calculateSnapshotRows(tx, snapshot.campaignId);
      if (
        recalculated.totalEntries !== snapshot.totalEntries
        || recalculated.canonicalCsv !== persisted.canonicalCsv
        || sha256(recalculated.canonicalCsv) !== snapshot.checksum
      ) {
        throw new Error("Snapshot no longer matches the canonical eligible ledger population");
      }

      const unresolvedPostSealCases = await tx.entryAdjustmentRequest.count({
        where: {
          tenantId: snapshot.tenantId,
          campaignId: snapshot.campaignId,
          status: { in: ["PENDING", "REVIEW", "APPROVED"] },
        },
      });
      if (unresolvedPostSealCases > 0) {
        throw new Error("Post-seal entry cases must be resolved before the draw");
      }
      const operatorApproval = snapshot.approvals.find((item) => item.kind === "OPERATIONS_RECONCILIATION" && item.status === "APPROVED");
      const witnessApproval = snapshot.approvals.find((item) => item.kind === "COMPLIANCE_WITNESS" && item.status === "APPROVED");
      if (!operatorApproval?.approverId || !witnessApproval?.approverId || operatorApproval.approverId === witnessApproval.approverId) {
        throw new Error("Distinct operations and compliance approvals are required before drawing");
      }
      if (operatorApproval.approverId !== operatorId) throw new Error("The approved draw operator must initiate the draw");
      await requireDrawStaff(tx, { userId: operatorId, tenantId: snapshot.tenantId, roles: ["ADMIN", "OPERATIONS"] });
      await requireDrawStaff(tx, { userId: witnessApproval.approverId, tenantId: snapshot.tenantId, roles: ["COMPLIANCE"] });
      const witnessId = witnessApproval.approverId;
      const count = Math.min(candidateCount, snapshot.rows.length);
      const seed = randomBytes(32);
      const selected = selectCandidates(snapshot.rows.map((row) => ({
        entryAccountId: row.entryAccountId,
        rangeStart: row.rangeStart,
        rangeEnd: row.rangeEnd,
      })), count, seed);
      const resultBody = selected.map((candidate, index) => `${index + 1},${candidate.entryAccountId},${candidate.selectedEntry}`).join("\n");
      const now = new Date();
      const draft = await tx.draw.create({
        data: {
          tenantId: snapshot.tenantId,
          campaignId: snapshot.campaignId,
          snapshotId: snapshot.id,
          status: "DRAFT",
          provider: "INTERNAL_DEMO",
          algorithm: "HMAC_SHA256_COUNTER_REJECTION_V1",
          algorithmVersion: 1,
          seedHash: sha256(seed),
          encryptedSeed: encryptDemoSeed(seed),
          resultChecksum: sha256(`${snapshot.checksum}\n${resultBody}\n`),
          operatorId,
          witnessId,
          conductedAt: now,
        },
      });
      await tx.drawCandidate.createMany({
        data: selected.map((candidate, index) => ({
          drawId: draft.id,
          entryAccountId: candidate.entryAccountId,
          rank: index + 1,
          selectedEntry: candidate.selectedEntry,
          status: index === 0 ? "CONTACTING" : "ALTERNATE",
        })),
      });
      const draw = await tx.draw.update({
        where: { id: draft.id },
        data: { status: "VERIFYING" },
        include: { candidates: { orderBy: { rank: "asc" } } },
      });
      await tx.campaign.update({ where: { id: snapshot.campaignId }, data: { status: "WINNER_PENDING" } });
      await tx.auditEvent.create({
        data: {
          tenantId: snapshot.tenantId,
          actorType: "ADMIN",
          actorId: operatorId,
          action: "DEMO_DRAW_CONDUCTED",
          resourceType: "Draw",
          resourceId: draw.id,
          metadataJson: JSON.stringify({ witnessId, snapshotChecksum: snapshot.checksum, resultChecksum: draw.resultChecksum, candidates: count }),
        },
      });
      return draw;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new Error("This snapshot already has a draw");
    }
    throw error;
  }
}
