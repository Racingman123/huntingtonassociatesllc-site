import { afterEach, describe, expect, it } from "vitest";
import { hashRateLimitIdentifier, publicRateLimitRules, rateLimitWindowStart } from "./rate-limit-core";

const originalSecret = process.env.RATE_LIMIT_SECRET;

afterEach(() => {
  process.env.RATE_LIMIT_SECRET = originalSecret;
});

describe("rate-limit primitives", () => {
  it("places timestamps into deterministic fixed windows", () => {
    expect(rateLimitWindowStart(new Date("2026-07-11T12:14:59.999Z"), 900).toISOString())
      .toBe("2026-07-11T12:00:00.000Z");
    expect(rateLimitWindowStart(new Date("2026-07-11T12:15:00.000Z"), 900).toISOString())
      .toBe("2026-07-11T12:15:00.000Z");
  });

  it("stores a normalized keyed digest rather than a public identifier", () => {
    process.env.RATE_LIMIT_SECRET = "unit-test-rate-limit-secret-at-least-32-chars";
    const first = hashRateLimitIdentifier("login:subject", " Person@Example.Test ");
    const replay = hashRateLimitIdentifier("login:subject", "person@example.test");
    expect(first).toBe(replay);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain("example");
  });

  it("adds an IP dimension only when a trusted address exists", () => {
    expect(publicRateLimitRules({
      scope: "login",
      subject: "person@example.test",
      subjectLimit: 8,
      ip: null,
      ipLimit: 40,
      windowSeconds: 900,
    })).toHaveLength(1);
    expect(publicRateLimitRules({
      scope: "login",
      subject: "person@example.test",
      subjectLimit: 8,
      ip: "192.0.2.10",
      ipLimit: 40,
      windowSeconds: 900,
    })).toHaveLength(2);
  });
});
