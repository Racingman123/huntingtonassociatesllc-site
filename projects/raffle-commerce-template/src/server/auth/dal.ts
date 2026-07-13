import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/server/db";
import { isStaffRole, SESSION_COOKIE_NAME } from "./config";
import { hashSessionToken } from "./crypto";
import { getRequestTenant } from "./tenant";
import type { AuthViewer } from "./types";

/** Secure database-backed session verification, memoized for one render pass. */
export const getOptionalViewer = cache(async (): Promise<AuthViewer | null> => {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const tenant = await getRequestTenant();
  const session = await db.session.findFirst({
    where: {
      tokenHash: hashSessionToken(token),
      tenantId: tenant.id,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      user: { status: "ACTIVE" },
    },
    select: {
      id: true,
      expiresAt: true,
      tenantId: true,
      user: {
        select: {
          id: true,
          role: true,
          name: true,
          email: true,
        },
      },
    },
  });

  if (!session) return null;

  return {
    sessionId: session.id,
    sessionExpiresAt: session.expiresAt,
    userId: session.user.id,
    tenantId: session.tenantId,
    role: session.user.role,
    name: session.user.name,
    email: session.user.email,
    tenant: {
      slug: tenant.slug,
      displayName: tenant.displayName,
      legalName: tenant.legalName,
      supportEmail: tenant.supportEmail,
      currency: tenant.currency,
      timezone: tenant.timezone,
    },
  };
});

export async function requireUser(): Promise<AuthViewer> {
  const viewer = await getOptionalViewer();
  if (!viewer) redirect("/login?next=/account");
  return viewer;
}

export async function requireStaff(): Promise<AuthViewer> {
  const viewer = await getOptionalViewer();
  if (!viewer) redirect("/login?next=/admin");
  if (!isStaffRole(viewer.role)) redirect("/account");
  return viewer;
}

export async function requireStaffRole(roles: readonly string[]): Promise<AuthViewer> {
  const viewer = await requireStaff();
  if (!roles.includes(viewer.role.toUpperCase())) redirect("/admin");
  return viewer;
}
