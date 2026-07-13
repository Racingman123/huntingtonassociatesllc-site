"use server";

import { hash } from "bcryptjs";
import { db } from "@/server/db";
import {
  consumeEmailVerificationChallenge,
  consumePasswordResetChallenge,
  issueAccountChallenge,
} from "./challenges";
import { normalizeEmail } from "./crypto";
import { getOptionalViewer } from "./dal";
import { getRequestTenant } from "./tenant";
import type { AccountChallengeActionState } from "./types";
import {
  emailVerificationSchema,
  passwordRecoveryRequestSchema,
  passwordResetSchema,
} from "./validation";
import {
  consumeRateLimits,
  getTrustedClientIp,
  publicRateLimitRules,
} from "@/server/security/rate-limit";

const GENERIC_REQUEST_MESSAGE =
  "If an eligible account matches that address, an email with the next step will be sent shortly.";

async function requestLimit(input: { tenantId: string; scope: string; email: string }) {
  return consumeRateLimits({
    tenantId: input.tenantId,
    rules: publicRateLimitRules({
      scope: input.scope,
      subject: input.email,
      subjectLimit: 3,
      ip: await getTrustedClientIp(),
      ipLimit: 20,
      windowSeconds: 60 * 60,
    }),
  });
}

export async function requestPasswordResetAction(
  _previousState: AccountChallengeActionState,
  formData: FormData,
): Promise<AccountChallengeActionState> {
  const parsed = passwordRecoveryRequestSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { status: "error", message: "Enter a valid email address.", errors: parsed.error.flatten().fieldErrors };
  }
  const tenant = await getRequestTenant();
  const normalizedEmail = normalizeEmail(parsed.data.email);
  const limit = await requestLimit({ tenantId: tenant.id, scope: "auth:password-recovery", email: normalizedEmail });
  if (limit.allowed) {
    const user = await db.user.findUnique({
      where: { tenantId_normalizedEmail: { tenantId: tenant.id, normalizedEmail } },
      select: { id: true, status: true },
    });
    if (user?.status === "ACTIVE") {
      try {
        await issueAccountChallenge({ tenantId: tenant.id, userId: user.id, purpose: "RESET_PASSWORD" });
      } catch {
        // Preserve the generic response. A concurrent request either created
        // the usable latest challenge or can be retried without identity leak.
      }
    }
  }
  return { status: "success", message: GENERIC_REQUEST_MESSAGE };
}

export async function requestEmailVerificationAction(
  _previousState: AccountChallengeActionState,
  formData: FormData,
): Promise<AccountChallengeActionState> {
  const [tenant, viewer] = await Promise.all([getRequestTenant(), getOptionalViewer()]);
  const parsed = passwordRecoveryRequestSchema.safeParse({
    email: viewer?.tenantId === tenant.id ? viewer.email : formData.get("email"),
  });
  if (!parsed.success) {
    return { status: "error", message: "Enter a valid email address.", errors: parsed.error.flatten().fieldErrors };
  }
  const normalizedEmail = normalizeEmail(parsed.data.email);
  const limit = await requestLimit({ tenantId: tenant.id, scope: "auth:email-verification", email: normalizedEmail });
  if (limit.allowed) {
    const user = await db.user.findUnique({
      where: { tenantId_normalizedEmail: { tenantId: tenant.id, normalizedEmail } },
      select: { id: true, status: true, emailVerifiedAt: true },
    });
    if (user?.status === "ACTIVE" && !user.emailVerifiedAt) {
      try {
        await issueAccountChallenge({ tenantId: tenant.id, userId: user.id, purpose: "VERIFY_EMAIL" });
      } catch {
        // Preserve the generic response across concurrent issuance races.
      }
    }
  }
  return { status: "success", message: GENERIC_REQUEST_MESSAGE };
}

export async function verifyEmailAction(
  _previousState: AccountChallengeActionState,
  formData: FormData,
): Promise<AccountChallengeActionState> {
  const parsed = emailVerificationSchema.safeParse({ token: formData.get("token") });
  if (!parsed.success) {
    return { status: "error", message: "This verification link is invalid or has expired." };
  }
  const tenant = await getRequestTenant();
  const limit = await consumeRateLimits({
    tenantId: tenant.id,
    rules: publicRateLimitRules({
      scope: "auth:email-verification-consume",
      subject: parsed.data.token.slice(-64),
      subjectLimit: 8,
      ip: await getTrustedClientIp(),
      ipLimit: 40,
      windowSeconds: 15 * 60,
    }),
  });
  if (!limit.allowed) return { status: "error", message: "This verification link is invalid or has expired." };
  const result = await consumeEmailVerificationChallenge({ tenantId: tenant.id, token: parsed.data.token });
  if (result === "VERIFIED" || result === "ALREADY_VERIFIED") {
    return { status: "success", message: "Your email is verified. You can now sign in to view any safely matched account history." };
  }
  if (result === "REVIEW_REQUIRED") {
    return { status: "success", message: "Your email is verified, but account history needs secure review. Support has the case and no entry records were merged. You can now sign in." };
  }
  return { status: "error", message: "This verification link is invalid or has expired." };
}

export async function resetPasswordAction(
  _previousState: AccountChallengeActionState,
  formData: FormData,
): Promise<AccountChallengeActionState> {
  const parsed = passwordResetSchema.safeParse({
    token: formData.get("token"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    return { status: "error", message: "Check the highlighted fields.", errors: parsed.error.flatten().fieldErrors };
  }
  const tenant = await getRequestTenant();
  const limit = await consumeRateLimits({
    tenantId: tenant.id,
    rules: publicRateLimitRules({
      scope: "auth:password-reset-consume",
      subject: parsed.data.token.slice(-64),
      subjectLimit: 8,
      ip: await getTrustedClientIp(),
      ipLimit: 40,
      windowSeconds: 15 * 60,
    }),
  });
  if (!limit.allowed) return { status: "error", message: "This reset link is invalid or has expired." };
  const passwordHash = await hash(parsed.data.password, 12);
  const result = await consumePasswordResetChallenge({
    tenantId: tenant.id,
    token: parsed.data.token,
    passwordHash,
  });
  return result === "RESET"
    ? { status: "success", message: "Password reset. All existing sessions were signed out; sign in with your new password." }
    : { status: "error", message: "This reset link is invalid or has expired." };
}
