import "server-only";

import { createHash, createHmac } from "node:crypto";

function receiptSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be configured before checkout");
  }
  return secret;
}

/**
 * Deterministic so an idempotent checkout retry can recover the same bearer
 * receipt without storing the raw token. Only its SHA-256 digest is persisted.
 */
export function createCheckoutReceiptToken(input: {
  tenantId: string;
  orderId: string;
  idempotencyKey: string;
}) {
  return createHmac("sha256", receiptSecret())
    .update(`checkout-receipt-v1\n${input.tenantId}\n${input.orderId}\n${input.idempotencyKey}`)
    .digest("base64url");
}

export function hashCheckoutReceiptToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function isCheckoutReceiptToken(value: string) {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}
