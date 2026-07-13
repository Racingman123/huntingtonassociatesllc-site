import "server-only";

import { cookies } from "next/headers";
import { db } from "@/server/db";
import {
  SESSION_COOKIE_NAME,
  SESSION_DURATION_SECONDS,
} from "./config";
import { createSessionToken, hashSessionToken } from "./crypto";

const cookieOptions = (expires: Date) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  expires,
  maxAge: SESSION_DURATION_SECONDS,
  priority: "high" as const,
});

export async function createDatabaseSession(input: { userId: string; tenantId: string }) {
  const cookieStore = await cookies();
  const previousToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000);

  await db.$transaction(async (tx) => {
    if (previousToken) {
      await tx.session.updateMany({
        where: {
          tokenHash: hashSessionToken(previousToken),
          tenantId: input.tenantId,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
    }

    await tx.session.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        tokenHash,
        expiresAt,
      },
    });
  });

  cookieStore.set(SESSION_COOKIE_NAME, token, cookieOptions(expiresAt));
  return expiresAt;
}

export async function revokeCurrentSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (token) {
    await db.session.updateMany({
      where: { tokenHash: hashSessionToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  cookieStore.delete(SESSION_COOKIE_NAME);
}

export async function revokeOtherSessions(userId: string, currentSessionId: string) {
  return db.session.updateMany({
    where: {
      userId,
      id: { not: currentSessionId },
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { revokedAt: new Date() },
  });
}

