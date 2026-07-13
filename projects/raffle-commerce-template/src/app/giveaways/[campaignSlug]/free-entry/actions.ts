"use server";

import { getRequestTenant } from "@/server/auth/tenant";
import { getOptionalViewer } from "@/server/auth/dal";
import { db } from "@/server/db";
import { freeEntrySchema, submitFreeEntry } from "@/server/entries/free-entry";
import {
  consumeRateLimits,
  getTrustedClientIp,
  publicRateLimitRules,
} from "@/server/security/rate-limit";

export type FreeEntryState = {
  message?: string;
  errors?: Record<string, string[]>;
  success?: { confirmationCode: string; entries: string; status: string };
};

function publicFreeEntryError(error: unknown) {
  if (!(error instanceof Error)) return "Your free entry could not be recorded.";
  const safeMessages = [
    "This promotion is unavailable",
    "The free-entry period is closed",
    "The free-entry method is not configured",
    "This location is not eligible for the promotion",
    "This entrant is not eligible for the promotion",
    "You have reached the entry cap for this promotion",
    "Official rules are unavailable",
  ];
  if (safeMessages.includes(error.message)) return error.message;
  if (/^One free-entry submission per email is allowed each campaign calendar day\./.test(error.message)) {
    return error.message;
  }
  return "Your free entry could not be recorded. No duplicate entry was created; please try again.";
}

export async function freeEntryAction(_previous: FreeEntryState, formData: FormData): Promise<FreeEntryState> {
  const parsed = freeEntrySchema.safeParse({
    campaignSlug: formData.get("campaignSlug"),
    email: formData.get("email"),
    name: formData.get("name"),
    phone: formData.get("phone"),
    region: formData.get("region"),
    postalCode: formData.get("postalCode"),
    country: formData.get("country"),
    ageConfirmed: formData.get("ageConfirmed") === "on",
    residenceConfirmed: formData.get("residenceConfirmed") === "on",
    rulesAccepted: formData.get("rulesAccepted") === "on",
    website: formData.get("website") || undefined,
  });
  if (!parsed.success) {
    return { message: "Please review the highlighted fields.", errors: parsed.error.flatten().fieldErrors };
  }
  try {
    const [tenant, clientIp, viewer] = await Promise.all([getRequestTenant(), getTrustedClientIp(), getOptionalViewer()]);
    const rateLimit = await consumeRateLimits({
      tenantId: tenant.id,
      rules: publicRateLimitRules({
        scope: "public:free-entry",
        subject: parsed.data.email,
        subjectLimit: 8,
        ip: clientIp,
        ipLimit: 40,
        windowSeconds: 24 * 60 * 60,
      }),
    });
    if (!rateLimit.allowed) {
      return { message: "Too many free-entry requests were received. Please try again later." };
    }
    let authenticatedIdentity: import("@/server/commerce/checkout").AuthenticatedEntrantIdentity | undefined;
    if (viewer?.tenantId === tenant.id) {
      if (viewer.email.toLowerCase() !== parsed.data.email.toLowerCase()) {
        return { message: "Use the email address attached to your signed-in account." };
      }
      const account = await db.user.findFirst({
        where: { id: viewer.userId, tenantId: tenant.id, status: "ACTIVE", emailVerifiedAt: { not: null } },
        select: { normalizedEmail: true, entrant: { select: { id: true } } },
      });
      if (account?.entrant) {
        authenticatedIdentity = {
          tenantId: tenant.id,
          userId: viewer.userId,
          entrantId: account.entrant.id,
          normalizedEmail: account.normalizedEmail,
        };
      }
    }
    const result = await submitFreeEntry(parsed.data, tenant.id, authenticatedIdentity);
    return {
      success: {
        confirmationCode: result.confirmationCode,
        entries: result.entries.toString(),
        status: result.status,
      },
    };
  } catch (error) {
    return { message: publicFreeEntryError(error) };
  }
}
