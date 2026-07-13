"use server";

import { z } from "zod";
import { getRequestTenant } from "@/server/auth/tenant";
import { db } from "@/server/db";
import {
  consumeRateLimits,
  getTrustedClientIp,
  publicRateLimitRules,
} from "@/server/security/rate-limit";
import { hashRateLimitIdentifier } from "@/server/security/rate-limit-core";

export type FormState = { success?: string; message?: string; errors?: Record<string, string[]> };

const newsletterSchema = z.object({
  email: z.email().trim().toLowerCase(),
  consent: z.literal(true),
});

const supportSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email().trim().toLowerCase(),
  subject: z.string().trim().min(3).max(120),
  message: z.string().trim().min(20).max(5000),
  website: z.string().max(0).optional(),
});

export async function subscribeNewsletter(_previous: FormState, formData: FormData): Promise<FormState> {
  const parsed = newsletterSchema.safeParse({
    email: formData.get("email"),
    consent: formData.get("consent") === "on",
  });
  if (!parsed.success) return { message: "Enter a valid email and confirm the optional subscription.", errors: parsed.error.flatten().fieldErrors };
  const [tenant, clientIp] = await Promise.all([getRequestTenant(), getTrustedClientIp()]);
  const rateLimit = await consumeRateLimits({
    tenantId: tenant.id,
    rules: publicRateLimitRules({
      scope: "public:newsletter",
      subject: parsed.data.email,
      subjectLimit: 5,
      ip: clientIp,
      ipLimit: 30,
      windowSeconds: 60 * 60,
    }),
  });
  if (!rateLimit.allowed) {
    return { message: "Too many subscription requests were received. Please try again later." };
  }
  await db.$transaction([
    db.newsletterSubscriber.upsert({
      where: { tenantId_normalizedEmail: { tenantId: tenant.id, normalizedEmail: parsed.data.email } },
      update: { status: "SUBSCRIBED", unsubscribedAt: null, consentText: "Optional email product news and promotion updates." },
      create: {
        tenantId: tenant.id,
        email: parsed.data.email,
        normalizedEmail: parsed.data.email,
        source: "STOREFRONT_FOOTER",
        consentText: "Optional email product news and promotion updates.",
      },
    }),
    db.consentEvent.create({
      data: {
        tenantId: tenant.id,
        subjectHash: hashRateLimitIdentifier("consent:newsletter", parsed.data.email),
        channel: "EMAIL",
        action: "GRANTED",
        policyVersion: "newsletter-v1",
        disclosure: "Send optional product news and future promotion updates. This does not affect entry or odds.",
        source: "STOREFRONT_FOOTER",
      },
    }),
  ]);
  return { success: "You’re subscribed. Check your inbox for future updates." };
}

export async function submitSupportRequest(_previous: FormState, formData: FormData): Promise<FormState> {
  const parsed = supportSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    subject: formData.get("subject"),
    message: formData.get("message"),
    website: formData.get("website") || undefined,
  });
  if (!parsed.success) return { message: "Please review the support form fields.", errors: parsed.error.flatten().fieldErrors };
  const [tenant, clientIp] = await Promise.all([getRequestTenant(), getTrustedClientIp()]);
  const rateLimit = await consumeRateLimits({
    tenantId: tenant.id,
    rules: publicRateLimitRules({
      scope: "public:support",
      subject: parsed.data.email,
      subjectLimit: 5,
      ip: clientIp,
      ipLimit: 20,
      windowSeconds: 60 * 60,
    }),
  });
  if (!rateLimit.allowed) {
    return { message: "Too many support requests were received. Please try again later." };
  }
  const ticket = await db.$transaction(async (tx) => {
    const created = await tx.supportTicket.create({
      data: {
        tenantId: tenant.id,
        name: parsed.data.name,
        email: parsed.data.email,
        subject: parsed.data.subject,
        message: parsed.data.message,
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: tenant.id,
        actorType: "VISITOR",
        action: "SUPPORT_TICKET_CREATED",
        resourceType: "SupportTicket",
        resourceId: created.id,
      },
    });
    await tx.outboxEvent.create({
      data: {
        tenantId: tenant.id,
        aggregateType: "SupportTicket",
        aggregateId: created.id,
        kind: "SUPPORT_ACKNOWLEDGMENT_EMAIL",
        payloadJson: JSON.stringify({ supportTicketId: created.id }),
        idempotencyKey: `support-acknowledgment:${created.id}`,
      },
    });
    return created;
  });
  return { success: `Thanks—your support reference is ${ticket.id.slice(-8).toUpperCase()}.` };
}
