"use server";

import { compare, hash } from "bcryptjs";
import { redirect } from "next/navigation";
import { db } from "@/server/db";
import { isStaffRole } from "./config";
import { hashIdentifier, normalizeEmail } from "./crypto";
import { getOptionalViewer } from "./dal";
import { createDatabaseSession, revokeCurrentSession } from "./session";
import { getRequestTenant } from "./tenant";
import type { AuthActionState } from "./types";
import { loginSchema, registrationSchema, safeRedirectPath } from "./validation";
import { issueAccountChallenge } from "./challenges";
import {
  consumeRateLimits,
  getTrustedClientIp,
  publicRateLimitRules,
} from "@/server/security/rate-limit";

const DUMMY_PASSWORD_HASH =
  "$2b$12$StEbEEyqFk1nAkGworQgF.bBg84E5Qg3YiXHX6hEElv44wwBZGFru";

export async function loginAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    redirectTo: formData.get("redirectTo") || undefined,
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: "Check the highlighted fields and try again.",
      errors: parsed.error.flatten().fieldErrors,
    };
  }

  const tenant = await getRequestTenant();
  const normalizedEmail = normalizeEmail(parsed.data.email);
  const loginLimit = await consumeRateLimits({
    tenantId: tenant.id,
    rules: publicRateLimitRules({
      scope: "auth:login",
      subject: normalizedEmail,
      subjectLimit: 12,
      ip: await getTrustedClientIp(),
      ipLimit: 60,
      windowSeconds: 15 * 60,
    }),
  });
  if (!loginLimit.allowed) {
    return {
      status: "error",
      message: `Too many sign-in attempts. Try again in about ${Math.ceil(loginLimit.retryAfterSeconds / 60)} minute(s).`,
    };
  }
  const user = await db.user.findUnique({
    where: {
      tenantId_normalizedEmail: { tenantId: tenant.id, normalizedEmail },
    },
    select: {
      id: true,
      tenantId: true,
      passwordHash: true,
      role: true,
      status: true,
      emailVerifiedAt: true,
    },
  });

  const passwordMatches = await compare(
    parsed.data.password,
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
  );

  if (!user || !passwordMatches || user.status !== "ACTIVE") {
    return {
      status: "error",
      message: "The email or password is incorrect.",
    };
  }

  if (!user.emailVerifiedAt) redirect("/verify-email/request?needed=1");

  await db.$transaction([
    db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    }),
    db.auditEvent.create({
      data: {
        tenantId: tenant.id,
        actorType: "USER",
        actorId: user.id,
        action: "USER_SIGNED_IN",
        resourceType: "Session",
        metadataJson: JSON.stringify({ role: user.role }),
      },
    }),
  ]);
  await createDatabaseSession({ userId: user.id, tenantId: user.tenantId });

  const fallback = isStaffRole(user.role) ? "/admin" : "/account";
  redirect(safeRedirectPath(parsed.data.redirectTo, fallback));
}

export async function registerAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = registrationSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
    acceptTerms: formData.get("acceptTerms"),
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: "Check the highlighted fields and try again.",
      errors: parsed.error.flatten().fieldErrors,
    };
  }

  const tenant = await getRequestTenant();
  const normalizedEmail = normalizeEmail(parsed.data.email);
  const registrationLimit = await consumeRateLimits({
    tenantId: tenant.id,
    rules: publicRateLimitRules({
      scope: "auth:register",
      subject: normalizedEmail,
      subjectLimit: 5,
      ip: await getTrustedClientIp(),
      ipLimit: 20,
      windowSeconds: 60 * 60,
    }),
  });
  if (!registrationLimit.allowed) {
    return {
      status: "error",
      message: "Too many account requests were received. Please try again later.",
    };
  }
  const [existing, passwordHash] = await Promise.all([
    db.user.findUnique({
    where: {
      tenantId_normalizedEmail: { tenantId: tenant.id, normalizedEmail },
    },
    select: { id: true },
    }),
    hash(parsed.data.password, 12),
  ]);

  if (existing) {
    redirect("/verify-email/request?sent=1");
  }

  try {
    const user = await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: normalizedEmail,
          normalizedEmail,
          name: parsed.data.name,
          passwordHash,
          role: "CUSTOMER",
        },
      });

      await tx.entrant.create({
        data: {
          tenantId: tenant.id,
          userId: created.id,
          normalizedEmail,
          emailHash: hashIdentifier(normalizedEmail),
          name: parsed.data.name,
        },
      });

      await tx.auditEvent.create({
        data: {
          tenantId: tenant.id,
          actorType: "USER",
          actorId: created.id,
          action: "USER_REGISTERED",
          resourceType: "User",
          resourceId: created.id,
          metadataJson: JSON.stringify({ source: "WEB_REGISTRATION" }),
        },
      });

      return created;
    });

    await issueAccountChallenge({
      tenantId: tenant.id,
      userId: user.id,
      purpose: "VERIFY_EMAIL",
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      redirect("/verify-email/request?sent=1");
    }
    throw error;
  }

  redirect("/verify-email/request?sent=1");
}

export async function logoutAction() {
  const viewer = await getOptionalViewer();
  if (viewer) {
    await db.auditEvent.create({
      data: {
        tenantId: viewer.tenantId,
        actorType: "USER",
        actorId: viewer.userId,
        action: "USER_SIGNED_OUT",
        resourceType: "Session",
        resourceId: viewer.sessionId,
      },
    });
  }
  await revokeCurrentSession();
  redirect("/login");
}
