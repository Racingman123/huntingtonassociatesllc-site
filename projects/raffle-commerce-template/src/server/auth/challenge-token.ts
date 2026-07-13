import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const accountChallengePurposes = ["VERIFY_EMAIL", "RESET_PASSWORD"] as const;
export type AccountChallengePurpose = (typeof accountChallengePurposes)[number];

const claimsSchema = z.object({
  v: z.literal(1),
  id: z.string().uuid(),
  tenantId: z.string().min(1).max(191),
  purpose: z.enum(accountChallengePurposes),
  expiresAt: z.string().datetime(),
}).strict();

export type AccountChallengeClaims = z.infer<typeof claimsSchema>;

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret)
    .update("account-challenge:v1:")
    .update(payload)
    .digest("base64url");
}

export function createSignedAccountChallengeToken(
  claims: Omit<AccountChallengeClaims, "v">,
  secret: string,
) {
  const payload = Buffer.from(JSON.stringify({ v: 1, ...claims }), "utf8").toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function readSignedAccountChallengeToken(token: string, secret: string) {
  if (token.length > 2_048) return null;
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) return null;
  const expectedSignature = signature(payload, secret);
  const supplied = Buffer.from(suppliedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    return claimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}
