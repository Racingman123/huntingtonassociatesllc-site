import "server-only";

import { isIP } from "node:net";
import { headers } from "next/headers";
import { db } from "@/server/db";
import {
  hashRateLimitIdentifier,
  rateLimitWindowStart,
  validateRateLimitRule,
  type RateLimitRule,
} from "./rate-limit-core";

export { publicRateLimitRules } from "./rate-limit-core";

export type RateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
  limit: number;
  remaining: number;
};

/**
 * Durable fixed-window limiter. The atomic upsert makes concurrent requests
 * share one counter on both the local demo database and production databases.
 */
export async function consumeRateLimit(input: {
  tenantId: string;
  rule: RateLimitRule;
  now?: Date;
}): Promise<RateLimitDecision> {
  validateRateLimitRule(input.rule);
  const now = input.now ?? new Date();
  const windowStart = rateLimitWindowStart(now, input.rule.windowSeconds);
  const identifierHash = hashRateLimitIdentifier(input.rule.scope, input.rule.identifier);
  const bucket = await db.rateLimitBucket.upsert({
    where: {
      tenantId_scope_identifierHash_windowStart: {
        tenantId: input.tenantId,
        scope: input.rule.scope,
        identifierHash,
        windowStart,
      },
    },
    create: {
      tenantId: input.tenantId,
      scope: input.rule.scope,
      identifierHash,
      windowStart,
      count: 1,
    },
    update: { count: { increment: 1 } },
    select: { count: true },
  });
  const windowEndMs = windowStart.getTime() + input.rule.windowSeconds * 1_000;
  return {
    allowed: bucket.count <= input.rule.limit,
    retryAfterSeconds: Math.max(1, Math.ceil((windowEndMs - now.getTime()) / 1_000)),
    limit: input.rule.limit,
    remaining: Math.max(0, input.rule.limit - bucket.count),
  };
}

export async function consumeRateLimits(input: {
  tenantId: string;
  rules: RateLimitRule[];
  now?: Date;
}) {
  const decisions = await Promise.all(input.rules.map((rule) => consumeRateLimit({
    tenantId: input.tenantId,
    rule,
    now: input.now,
  })));
  const denied = decisions.filter((decision) => !decision.allowed);
  return {
    allowed: denied.length === 0,
    retryAfterSeconds: denied.length
      ? Math.max(...denied.map((decision) => decision.retryAfterSeconds))
      : 0,
    decisions,
  };
}

/** Only use forwarding headers when an operator explicitly trusts its proxy. */
export async function getTrustedClientIp() {
  if (process.env.TRUST_PROXY_HEADERS !== "true") return null;
  const requestHeaders = await headers();
  const candidates = [
    requestHeaders.get("cf-connecting-ip"),
    requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    requestHeaders.get("x-real-ip"),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && isIP(candidate))) ?? null;
}
