import { describe, expect, test } from "vitest";
import {
  createSignedAccountChallengeToken,
  readSignedAccountChallengeToken,
} from "./challenge-token";

const secret = "unit-test-account-challenge-secret-at-least-32-characters";
const claims = {
  id: "04e65746-f593-44b1-aa50-781b0272ef41",
  tenantId: "tenant_test",
  purpose: "VERIFY_EMAIL" as const,
  expiresAt: "2026-07-12T12:00:00.000Z",
};

describe("signed account challenge tokens", () => {
  test("round-trips deterministic claims without storing a bearer secret", () => {
    const token = createSignedAccountChallengeToken(claims, secret);
    expect(token).toBe(createSignedAccountChallengeToken(claims, secret));
    expect(readSignedAccountChallengeToken(token, secret)).toEqual({ v: 1, ...claims });
  });

  test("rejects tampering, wrong secrets, and malformed claims", () => {
    const token = createSignedAccountChallengeToken(claims, secret);
    expect(readSignedAccountChallengeToken(`${token.slice(0, -1)}x`, secret)).toBeNull();
    expect(readSignedAccountChallengeToken(token, `${secret}-wrong`)).toBeNull();
    expect(readSignedAccountChallengeToken("not-a-token", secret)).toBeNull();
  });
});
