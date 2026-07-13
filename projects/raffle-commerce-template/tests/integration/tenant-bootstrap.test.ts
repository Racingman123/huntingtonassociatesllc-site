import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import bcrypt from "bcryptjs";
import { afterAll, describe, expect, test } from "vitest";
import { db } from "@/server/db";

const projectRoot = resolve(import.meta.dirname, "../..");
const adminPassword = "Cedar!Orbit9-Violet";
const compliancePassword = "Maple!Comet7-Harbor";

function manifest(suffix: string) {
  return {
    schemaVersion: 1,
    tenant: {
      slug: `bootstrap-${suffix}`,
      displayName: `Bootstrap ${suffix}`,
      legalName: `Bootstrap ${suffix} LLC`,
      supportEmail: `support-${suffix}@example.test`,
      primaryDomain: `${suffix}.giveaway.example.test`,
      currency: "USD",
      timezone: "America/New_York",
    },
    initialStaff: {
      administrator: {
        name: "Alex Administrator",
        email: `admin-${suffix}@example.test`,
        mailboxVerification: {
          verifiedAt: "2026-07-01T14:00:00Z",
          evidenceRef: `mailbox-proof://${suffix}/admin`,
        },
      },
      compliance: {
        name: "Casey Compliance",
        email: `compliance-${suffix}@example.test`,
        mailboxVerification: {
          verifiedAt: "2026-07-01T14:30:00Z",
          evidenceRef: `mailbox-proof://${suffix}/compliance`,
        },
      },
    },
  };
}

function runTenantCli(
  command: "plan" | "bootstrap",
  config: unknown,
  options: { confirm?: boolean; environment?: Record<string, string> } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "tenant-bootstrap-cli-"));
  const configPath = join(directory, "tenant.json");
  writeFileSync(configPath, JSON.stringify(config));
  try {
    const args = ["--import", "tsx", "scripts/tenant.ts", command, configPath];
    if (options.confirm) args.push("--confirm");
    const result = spawnSync(process.execPath, args, {
      cwd: projectRoot,
      env: { ...process.env, ...options.environment },
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    return {
      status: result.status,
      output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

afterAll(async () => {
  await db.$disconnect();
});

describe.sequential("tenant and initial-staff bootstrap", () => {
  test("plans without writing, then atomically creates verified privileged staff and a safe audit", async () => {
    const config = manifest("primary");
    const before = await db.tenant.count();
    const plan = runTenantCli("plan", config);
    expect(plan.status, plan.output).toBe(0);
    expect(plan.output).toMatch(/"readOnly": true/);
    expect(plan.output).toMatch(/"bootstrapReady": true/);
    expect(await db.tenant.count()).toBe(before);

    const withoutConfirmation = runTenantCli("bootstrap", config, {
      environment: {
        BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
        BOOTSTRAP_COMPLIANCE_PASSWORD: compliancePassword,
      },
    });
    expect(withoutConfirmation.status).not.toBe(0);
    expect(withoutConfirmation.output).toMatch(/--confirm/);
    expect(await db.tenant.count()).toBe(before);

    const result = runTenantCli("bootstrap", config, {
      confirm: true,
      environment: {
        BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
        BOOTSTRAP_COMPLIANCE_PASSWORD: compliancePassword,
      },
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(/"created": true/);
    expect(result.output).not.toContain(adminPassword);
    expect(result.output).not.toContain(compliancePassword);
    expect(result.output).not.toMatch(/\$2[aby]\$/);

    const tenant = await db.tenant.findUniqueOrThrow({
      where: { slug: config.tenant.slug },
      include: {
        users: { orderBy: { role: "asc" } },
        audits: true,
      },
    });
    expect(tenant).toMatchObject({
      displayName: config.tenant.displayName,
      legalName: config.tenant.legalName,
      primaryDomain: config.tenant.primaryDomain,
      currency: "USD",
      timezone: "America/New_York",
      status: "ACTIVE",
    });
    expect(tenant.users.map((user) => ({
      email: user.email,
      role: user.role,
      status: user.status,
      verified: Boolean(user.emailVerifiedAt),
    }))).toEqual([
      { email: config.initialStaff.administrator.email, role: "ADMIN", status: "ACTIVE", verified: true },
      { email: config.initialStaff.compliance.email, role: "COMPLIANCE", status: "ACTIVE", verified: true },
    ]);
    const administrator = tenant.users.find((user) => user.role === "ADMIN")!;
    const compliance = tenant.users.find((user) => user.role === "COMPLIANCE")!;
    expect(bcrypt.getRounds(administrator.passwordHash)).toBe(12);
    expect(bcrypt.getRounds(compliance.passwordHash)).toBe(12);
    expect(await bcrypt.compare(adminPassword, administrator.passwordHash)).toBe(true);
    expect(await bcrypt.compare(compliancePassword, compliance.passwordHash)).toBe(true);
    expect(administrator.passwordHash).not.toBe(compliance.passwordHash);
    expect(administrator.emailVerifiedAt?.toISOString()).toBe(
      config.initialStaff.administrator.mailboxVerification.verifiedAt.replace("Z", ".000Z"),
    );
    expect(compliance.emailVerifiedAt?.toISOString()).toBe(
      config.initialStaff.compliance.mailboxVerification.verifiedAt.replace("Z", ".000Z"),
    );

    expect(tenant.audits).toHaveLength(1);
    expect(tenant.audits[0]).toMatchObject({
      actorType: "SYSTEM",
      action: "TENANT_BOOTSTRAPPED",
      resourceType: "Tenant",
      resourceId: tenant.id,
    });
    expect(tenant.audits[0]!.metadataJson).toMatch(/"manifestChecksum":"[a-f0-9]{64}"/);
    expect(tenant.audits[0]!.metadataJson).toContain(config.initialStaff.administrator.mailboxVerification.evidenceRef);
    expect(tenant.audits[0]!.metadataJson).toContain(config.initialStaff.compliance.mailboxVerification.evidenceRef);
    expect(tenant.audits[0]!.metadataJson).not.toContain(adminPassword);
    expect(tenant.audits[0]!.metadataJson).not.toContain(compliancePassword);
    expect(tenant.audits[0]!.metadataJson).not.toMatch(/password|\$2[aby]\$/i);
  }, 60_000);

  test("fails closed on replay, domain collision, and cross-tenant staff email collision", async () => {
    const original = manifest("primary");
    const environment = {
      BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      BOOTSTRAP_COMPLIANCE_PASSWORD: compliancePassword,
    };
    const countBefore = await db.tenant.count();

    const replay = runTenantCli("bootstrap", original, { confirm: true, environment });
    expect(replay.status).not.toBe(0);
    expect(replay.output).toMatch(/existing tenant slug|primary domain|staff email/i);

    const domainCollision = manifest("domain-collision");
    domainCollision.tenant.primaryDomain = original.tenant.primaryDomain;
    const repeatedDomain = runTenantCli("bootstrap", domainCollision, { confirm: true, environment });
    expect(repeatedDomain.status).not.toBe(0);
    expect(repeatedDomain.output).toMatch(/primary domain/i);

    const emailCollision = manifest("email-collision");
    emailCollision.initialStaff.administrator.email = original.initialStaff.administrator.email;
    const repeatedEmail = runTenantCli("bootstrap", emailCollision, { confirm: true, environment });
    expect(repeatedEmail.status).not.toBe(0);
    expect(repeatedEmail.output).toMatch(/staff email/i);

    expect(await db.tenant.count()).toBe(countBefore);
  }, 60_000);
});
