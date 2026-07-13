import { describe, expect, test } from "vitest";
import {
  BOOTSTRAP_BCRYPT_COST,
  bootstrapPasswordSchema,
  parseTenantBootstrap,
  tenantBootstrapChecksum,
} from "./overlay";

function validConfig() {
  return {
    schemaVersion: 1,
    tenant: {
      slug: "acme-adventures",
      displayName: "Acme Adventures",
      legalName: "Acme Adventures LLC",
      supportEmail: "support@acme.example",
      primaryDomain: "giveaway.acme.example",
      currency: "USD",
      timezone: "America/New_York",
    },
    initialStaff: {
      administrator: {
        name: "Alex Administrator",
        email: "admin@acme.example",
        mailboxVerification: {
          verifiedAt: "2026-07-01T14:00:00Z",
          evidenceRef: "mailbox-proof://acme/admin",
        },
      },
      compliance: {
        name: "Casey Compliance",
        email: "compliance@acme.example",
        mailboxVerification: {
          verifiedAt: "2026-07-01T14:30:00Z",
          evidenceRef: "mailbox-proof://acme/compliance",
        },
      },
    },
  };
}

describe("tenant bootstrap overlay", () => {
  test("normalizes email and domain fields and checksums deterministically", () => {
    const input = validConfig();
    input.tenant.supportEmail = " SUPPORT@ACME.EXAMPLE ";
    input.tenant.primaryDomain = "GIVEAWAY.ACME.EXAMPLE";
    const parsed = parseTenantBootstrap(input);

    expect(parsed.tenant.supportEmail).toBe("support@acme.example");
    expect(parsed.tenant.primaryDomain).toBe("giveaway.acme.example");
    expect(tenantBootstrapChecksum(parsed)).toMatch(/^[a-f0-9]{64}$/);
    expect(tenantBootstrapChecksum(parsed)).toBe(tenantBootstrapChecksum(parseTenantBootstrap(input)));
  });

  test("requires separate administrator and compliance identities", () => {
    const input = validConfig();
    input.initialStaff.compliance.email = input.initialStaff.administrator.email;
    expect(() => parseTenantBootstrap(input)).toThrow(/distinct email/i);
  });

  test("rejects unsafe domains, currencies, and time zones", () => {
    const input = validConfig();
    input.tenant.primaryDomain = "https://acme.example/path";
    input.tenant.currency = "usd";
    input.tenant.timezone = "Eastern Somewhere";
    expect(() => parseTenantBootstrap(input)).toThrow(/hostname|currency|time zone/i);

    const unsupportedMinorUnits = validConfig();
    unsupportedMinorUnits.tenant.currency = "JPY";
    expect(() => parseTenantBootstrap(unsupportedMinorUnits)).toThrow(/two minor-unit digits/i);
  });

  test("enforces non-placeholder strong bootstrap passwords and cost 12", () => {
    expect(BOOTSTRAP_BCRYPT_COST).toBe(12);
    expect(bootstrapPasswordSchema.safeParse("ChangeMeNow123!").success).toBe(false);
    expect(bootstrapPasswordSchema.safeParse("short").success).toBe(false);
    expect(bootstrapPasswordSchema.parse("Cedar!Orbit9-Violet")).toBe("Cedar!Orbit9-Violet");
    expect(bootstrapPasswordSchema.safeParse(`${"A".repeat(72)}a1!`).success).toBe(false);
  });
});
