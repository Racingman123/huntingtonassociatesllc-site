import "server-only";

import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import {
  createSignedAccountChallengeToken,
  readSignedAccountChallengeToken,
  type AccountChallengePurpose,
} from "./challenge-token";
import {
  getAccountChallengeSecret,
  hashAccountChallengeToken,
  hashIdentifier,
} from "./crypto";

const CHALLENGE_TTL_MS = 60 * 60 * 1_000;

type ChallengeFacts = {
  id: string;
  tenantId: string;
  purpose: string;
  expiresAt: Date;
};

function challengeToken(facts: ChallengeFacts) {
  if (!(["VERIFY_EMAIL", "RESET_PASSWORD"] as string[]).includes(facts.purpose)) {
    throw new Error("Unsupported account challenge purpose");
  }
  return createSignedAccountChallengeToken({
    id: facts.id,
    tenantId: facts.tenantId,
    purpose: facts.purpose as AccountChallengePurpose,
    expiresAt: facts.expiresAt.toISOString(),
  }, getAccountChallengeSecret());
}

/** Deterministically reconstructs the signed token without persisting plaintext. */
export function reconstructAccountChallengeToken(facts: ChallengeFacts) {
  return challengeToken(facts);
}

export async function issueAccountChallenge(input: {
  tenantId: string;
  userId: string;
  purpose: AccountChallengePurpose;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  const id = randomUUID();
  const token = challengeToken({ id, tenantId: input.tenantId, purpose: input.purpose, expiresAt });
  const tokenDigest = hashAccountChallengeToken(token);
  const kind = input.purpose === "VERIFY_EMAIL"
    ? "ACCOUNT_EMAIL_VERIFICATION"
    : "ACCOUNT_PASSWORD_RECOVERY";

  const challenge = await db.$transaction(async (tx) => {
    const user = await tx.user.findFirst({
      where: { id: input.userId, tenantId: input.tenantId, status: "ACTIVE" },
      select: { id: true, emailVerifiedAt: true, updatedAt: true },
    });
    if (!user || (input.purpose === "VERIFY_EMAIL" && user.emailVerifiedAt)) return null;
    // Claim the user row as a per-user issuance mutex. Two requests that read
    // the same revision cannot both create a live bearer challenge.
    const claimedAt = new Date(Math.max(Date.now(), now.getTime(), user.updatedAt.getTime() + 1));
    const claim = await tx.user.updateMany({
      where: {
        id: user.id,
        tenantId: input.tenantId,
        status: "ACTIVE",
        updatedAt: user.updatedAt,
      },
      data: { updatedAt: claimedAt },
    });
    if (claim.count !== 1) throw new Error("Account challenge issuance changed concurrently; retry");
    const superseded = await tx.accountChallenge.updateMany({
      where: {
        tenantId: input.tenantId,
        userId: user.id,
        purpose: input.purpose,
        consumedAt: null,
      },
      data: { consumedAt: now },
    });
    const created = await tx.accountChallenge.create({
      data: { id, tenantId: input.tenantId, userId: user.id, purpose: input.purpose, tokenDigest, expiresAt },
    });
    await tx.outboxEvent.create({
      data: {
        tenantId: input.tenantId,
        aggregateType: "AccountChallenge",
        aggregateId: created.id,
        kind,
        payloadJson: "{}",
        idempotencyKey: `account-challenge:${created.id}`,
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: "SYSTEM",
        actorId: "account-security",
        action: `${input.purpose}_CHALLENGE_ISSUED`,
        resourceType: "AccountChallenge",
        resourceId: created.id,
        metadataJson: JSON.stringify({
          expiresAt: expiresAt.toISOString(),
          supersededChallenges: superseded.count,
        }),
      },
    });
    return created;
  });

  return { created: Boolean(challenge), expiresAt };
}

function readChallenge(token: string, expectedTenantId: string, purpose: AccountChallengePurpose) {
  const claims = readSignedAccountChallengeToken(token, getAccountChallengeSecret());
  if (!claims || claims.tenantId !== expectedTenantId || claims.purpose !== purpose) return null;
  return claims;
}

function entrantRelationCount(count: Record<string, number>) {
  return Object.values(count).reduce((total, value) => total + value, 0);
}

export type VerifyEmailResult = "VERIFIED" | "ALREADY_VERIFIED" | "REVIEW_REQUIRED" | "INVALID";

export async function consumeEmailVerificationChallenge(input: {
  tenantId: string;
  token: string;
  now?: Date;
}): Promise<VerifyEmailResult> {
  const now = input.now ?? new Date();
  const claims = readChallenge(input.token, input.tenantId, "VERIFY_EMAIL");
  if (!claims || new Date(claims.expiresAt) <= now) return "INVALID";
  const tokenDigest = hashAccountChallengeToken(input.token);

  const challenge = await db.accountChallenge.findFirst({
    where: {
      id: claims.id,
      tenantId: input.tenantId,
      purpose: "VERIFY_EMAIL",
      tokenDigest,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true, userId: true, expiresAt: true },
  });
  if (!challenge || challenge.expiresAt.toISOString() !== claims.expiresAt) return "INVALID";

  return db.$transaction(async (tx) => {
    const consumed = await tx.accountChallenge.updateMany({
      where: {
        id: challenge.id,
        tenantId: input.tenantId,
        tokenDigest,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) return "INVALID";

    const user = await tx.user.findFirst({
      where: { id: challenge.userId, tenantId: input.tenantId, status: "ACTIVE" },
      select: { id: true, name: true, email: true, normalizedEmail: true, emailVerifiedAt: true },
    });
    if (!user) return "INVALID";
    if (user.emailVerifiedAt) return "ALREADY_VERIFIED";

    const entrants = await tx.entrant.findMany({
      where: { tenantId: input.tenantId, normalizedEmail: user.normalizedEmail },
      include: {
        _count: {
          select: {
            campaigns: true,
            orders: true,
            accounts: true,
            freeEntries: true,
            winners: true,
            ruleAcceptances: true,
            subscriptions: true,
          },
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const populated = entrants.filter((entrant) => entrantRelationCount(entrant._count) > 0);
    const linked = entrants.find((entrant) => entrant.userId === user.id);
    const ownedByAnotherUser = entrants.some((entrant) => entrant.userId && entrant.userId !== user.id);
    const entrantIds = entrants.map((entrant) => entrant.id);
    const [ordersOwnedByAnotherUser, subscriptionsOwnedByAnotherUser] = entrantIds.length
      ? await Promise.all([
          tx.order.count({
            where: {
              tenantId: input.tenantId,
              entrantId: { in: entrantIds },
              AND: [{ userId: { not: null } }, { userId: { not: user.id } }],
            },
          }),
          tx.subscription.count({
            where: {
              tenantId: input.tenantId,
              entrantId: { in: entrantIds },
              AND: [{ userId: { not: null } }, { userId: { not: user.id } }],
            },
          }),
        ])
      : [0, 0];
    const unsafe = ownedByAnotherUser
      || ordersOwnedByAnotherUser > 0
      || subscriptionsOwnedByAnotherUser > 0
      || populated.length > 1
      || Boolean(linked && entrantRelationCount(linked._count) > 0 && populated[0]?.id !== linked.id);

    if (unsafe) {
      const ticket = await tx.supportTicket.create({
        data: {
          tenantId: input.tenantId,
          userId: user.id,
          email: user.email,
          name: user.name,
          subject: "Account history claim requires review",
          message: "Email ownership was proven, but multiple populated entrant histories or an existing owner prevented an automatic claim. Staff must review identities without merging ledger records.",
          status: "OPEN",
        },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: input.tenantId,
          actorType: "USER",
          actorId: user.id,
          action: "ACCOUNT_HISTORY_CLAIM_REVIEW_REQUIRED",
          resourceType: "SupportTicket",
          resourceId: ticket.id,
          metadataJson: JSON.stringify({
            entrantCount: entrants.length,
            populatedEntrantCount: populated.length,
            ordersOwnedByAnotherUser,
            subscriptionsOwnedByAnotherUser,
          }),
        },
      });
      await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: now } });
      await tx.accountChallenge.updateMany({
        where: { tenantId: input.tenantId, userId: user.id, purpose: "VERIFY_EMAIL", consumedAt: null },
        data: { consumedAt: now },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: input.tenantId,
          actorType: "USER",
          actorId: user.id,
          action: "EMAIL_VERIFIED_HISTORY_UNMERGED",
          resourceType: "User",
          resourceId: user.id,
          metadataJson: JSON.stringify({ supportTicketId: ticket.id }),
        },
      });
      return "REVIEW_REQUIRED";
    }

    let canonical = populated[0] ?? linked ?? entrants[0];
    if (!canonical) {
      canonical = await tx.entrant.create({
        data: {
          tenantId: input.tenantId,
          userId: user.id,
          normalizedEmail: user.normalizedEmail,
          emailHash: hashIdentifier(user.normalizedEmail),
          name: user.name,
        },
        include: {
          _count: {
            select: {
              campaigns: true,
              orders: true,
              accounts: true,
              freeEntries: true,
              winners: true,
              ruleAcceptances: true,
              subscriptions: true,
            },
          },
        },
      });
    } else if (canonical.userId !== user.id) {
      if (linked) {
        await tx.entrant.update({ where: { id: linked.id }, data: { userId: null } });
      }
      canonical = await tx.entrant.update({
        where: { id: canonical.id },
        data: { userId: user.id },
        include: {
          _count: {
            select: {
              campaigns: true,
              orders: true,
              accounts: true,
              freeEntries: true,
              winners: true,
              ruleAcceptances: true,
              subscriptions: true,
            },
          },
        },
      });
    }

    const emptyDuplicateIds = entrants
      .filter((entrant) => entrant.id !== canonical.id && entrantRelationCount(entrant._count) === 0)
      .map((entrant) => entrant.id);
    if (emptyDuplicateIds.length) {
      await tx.entrant.deleteMany({ where: { id: { in: emptyDuplicateIds }, userId: null } });
    }
    const [claimedOrders, claimedSubscriptions] = await Promise.all([
      tx.order.updateMany({
        where: { tenantId: input.tenantId, entrantId: canonical.id, userId: null },
        data: { userId: user.id },
      }),
      tx.subscription.updateMany({
        where: { tenantId: input.tenantId, entrantId: canonical.id, userId: null },
        data: { userId: user.id },
      }),
    ]);
    await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: now } });
    await tx.accountChallenge.updateMany({
      where: { tenantId: input.tenantId, userId: user.id, purpose: "VERIFY_EMAIL", consumedAt: null },
      data: { consumedAt: now },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: "USER",
        actorId: user.id,
        action: "EMAIL_VERIFIED_AND_HISTORY_CLAIMED",
        resourceType: "User",
        resourceId: user.id,
        metadataJson: JSON.stringify({
          entrantId: canonical.id,
          removedEmptyDuplicates: emptyDuplicateIds.length,
          claimedOrders: claimedOrders.count,
          claimedSubscriptions: claimedSubscriptions.count,
        }),
      },
    });
    return "VERIFIED";
  });
}

export type ResetPasswordResult = "RESET" | "INVALID";

export async function consumePasswordResetChallenge(input: {
  tenantId: string;
  token: string;
  passwordHash: string;
  now?: Date;
}): Promise<ResetPasswordResult> {
  const now = input.now ?? new Date();
  const claims = readChallenge(input.token, input.tenantId, "RESET_PASSWORD");
  if (!claims || new Date(claims.expiresAt) <= now) return "INVALID";
  const tokenDigest = hashAccountChallengeToken(input.token);
  const challenge = await db.accountChallenge.findFirst({
    where: {
      id: claims.id,
      tenantId: input.tenantId,
      purpose: "RESET_PASSWORD",
      tokenDigest,
      consumedAt: null,
      expiresAt: { gt: now },
      user: { status: "ACTIVE" },
    },
    select: { id: true, userId: true, expiresAt: true },
  });
  if (!challenge || challenge.expiresAt.toISOString() !== claims.expiresAt) return "INVALID";

  return db.$transaction(async (tx) => {
    const consumed = await tx.accountChallenge.updateMany({
      where: { id: challenge.id, tenantId: input.tenantId, tokenDigest, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) return "INVALID";
    const updated = await tx.user.updateMany({
      where: { id: challenge.userId, tenantId: input.tenantId, status: "ACTIVE" },
      data: { passwordHash: input.passwordHash },
    });
    if (updated.count !== 1) return "INVALID";
    const sessions = await tx.session.updateMany({
      where: { tenantId: input.tenantId, userId: challenge.userId, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.accountChallenge.updateMany({
      where: { tenantId: input.tenantId, userId: challenge.userId, purpose: "RESET_PASSWORD", consumedAt: null },
      data: { consumedAt: now },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: "USER",
        actorId: challenge.userId,
        action: "PASSWORD_RESET_COMPLETED",
        resourceType: "User",
        resourceId: challenge.userId,
        metadataJson: JSON.stringify({ sessionsRevoked: sessions.count }),
      },
    });
    return "RESET";
  });
}
