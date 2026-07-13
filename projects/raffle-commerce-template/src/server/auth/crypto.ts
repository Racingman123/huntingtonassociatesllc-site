import "server-only";

import { createHash, createHmac, randomBytes } from "node:crypto";

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be configured with at least 32 characters");
  }
  return secret;
}

export function createSessionToken() {
  return randomBytes(32).toString("base64url");
}

/** The database never stores the bearer token sent to the browser. */
export function hashSessionToken(token: string) {
  return createHmac("sha256", getSessionSecret()).update(token).digest("hex");
}

export function getAccountChallengeSecret() {
  return createHmac("sha256", getSessionSecret())
    .update("account-challenge-signing-key:v1")
    .digest("base64url");
}

/** The challenge bearer token is reconstructed from signed claims, never persisted. */
export function hashAccountChallengeToken(token: string) {
  return createHmac("sha256", getSessionSecret())
    .update("account-challenge-token:v1:")
    .update(token)
    .digest("hex");
}

/** Stable, non-reversible identifier used by the entrant domain model. */
export function hashIdentifier(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}
