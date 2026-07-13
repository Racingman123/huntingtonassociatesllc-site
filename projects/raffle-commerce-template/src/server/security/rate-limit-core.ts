import { createHmac } from "node:crypto";

export type RateLimitRule = {
  scope: string;
  identifier: string;
  limit: number;
  windowSeconds: number;
};

export function rateLimitWindowStart(now: Date, windowSeconds: number) {
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86_400) {
    throw new Error("Rate-limit window must be an integer from 1 to 86400 seconds");
  }
  const windowMs = windowSeconds * 1_000;
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

export function hashRateLimitIdentifier(scope: string, identifier: string) {
  const secret = process.env.RATE_LIMIT_SECRET || process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("RATE_LIMIT_SECRET or SESSION_SECRET must contain at least 32 characters");
  }
  return createHmac("sha256", secret)
    .update("giveaway-rate-limit-v1\0")
    .update(scope)
    .update("\0")
    .update(identifier.trim().toLowerCase())
    .digest("hex");
}

export function validateRateLimitRule(rule: RateLimitRule) {
  if (!/^[a-z0-9:_-]{1,80}$/i.test(rule.scope)) throw new Error("Invalid rate-limit scope");
  if (!rule.identifier.trim() || rule.identifier.length > 500) throw new Error("Invalid rate-limit identifier");
  if (!Number.isSafeInteger(rule.limit) || rule.limit < 1 || rule.limit > 100_000) {
    throw new Error("Rate-limit threshold must be an integer from 1 to 100000");
  }
  rateLimitWindowStart(new Date(), rule.windowSeconds);
}

export function publicRateLimitRules(input: {
  scope: string;
  subject: string;
  subjectLimit: number;
  ip: string | null;
  ipLimit: number;
  windowSeconds: number;
}): RateLimitRule[] {
  return [
    {
      scope: `${input.scope}:subject`,
      identifier: input.subject,
      limit: input.subjectLimit,
      windowSeconds: input.windowSeconds,
    },
    ...(input.ip ? [{
      scope: `${input.scope}:ip`,
      identifier: input.ip,
      limit: input.ipLimit,
      windowSeconds: input.windowSeconds,
    }] : []),
  ];
}
