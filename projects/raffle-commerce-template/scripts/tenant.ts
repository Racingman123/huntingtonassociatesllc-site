import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import {
  BOOTSTRAP_BCRYPT_COST,
  bootstrapPasswordSchema,
  parseTenantBootstrap,
  tenantBootstrapChecksum,
  type TenantBootstrap,
} from "../src/server/tenant/overlay";

const prisma = new PrismaClient();

type InspectionClient = PrismaClient | Prisma.TransactionClient;

function usage(): never {
  throw new Error([
    "Usage:",
    "  npm run tenant:validate -- config/tenant.example.json",
    "  npm run tenant:plan -- config/tenant.example.json",
    "  BOOTSTRAP_ADMIN_PASSWORD='<strong-secret>' BOOTSTRAP_COMPLIANCE_PASSWORD='<different-strong-secret>' \\",
    "    npm run tenant:bootstrap -- config/tenant.example.json --confirm",
  ].join("\n"));
}

async function load(file: string) {
  const config = parseTenantBootstrap(JSON.parse(await readFile(resolve(file), "utf8")));
  return { config, checksum: tenantBootstrapChecksum(config) };
}

async function inspect(client: InspectionClient, config: TenantBootstrap) {
  // Read all tenant identity keys so legacy mixed-case values cannot bypass the
  // bootstrap tool's normalized, case-insensitive collision policy.
  const [tenants, users] = await Promise.all([
    client.tenant.findMany({
      select: { id: true, slug: true, primaryDomain: true },
    }),
    client.user.findMany({
      where: {
        normalizedEmail: {
          in: [
            config.initialStaff.administrator.email,
            config.initialStaff.compliance.email,
          ],
        },
      },
      select: {
        id: true,
        normalizedEmail: true,
        role: true,
        tenant: { select: { slug: true } },
      },
    }),
  ]);

  const slugCollision = tenants.find((tenant) => tenant.slug.toLowerCase() === config.tenant.slug);
  const domainCollision = tenants.find((tenant) => (
    tenant.primaryDomain?.toLowerCase() === config.tenant.primaryDomain
  ));
  const staffEmailCollisions = users.map((user) => ({
    userId: user.id,
    email: user.normalizedEmail,
    role: user.role,
    tenant: user.tenant.slug,
  }));

  return {
    slugCollision: slugCollision ? { tenantId: slugCollision.id, slug: slugCollision.slug } : null,
    domainCollision: domainCollision ? {
      tenantId: domainCollision.id,
      domain: domainCollision.primaryDomain,
    } : null,
    staffEmailCollisions,
    ready: !slugCollision && !domainCollision && staffEmailCollisions.length === 0,
  };
}

async function printPlan(config: TenantBootstrap, checksum: string) {
  const state = await inspect(prisma, config);
  console.log(JSON.stringify({
    operation: "CREATE_NEW_TENANT_AND_INITIAL_STAFF",
    readOnly: true,
    manifestChecksum: checksum,
    tenant: config.tenant,
    initialStaff: [
      { role: "ADMIN", ...config.initialStaff.administrator },
      { role: "COMPLIANCE", ...config.initialStaff.compliance },
    ],
    checks: {
      slugAvailable: state.slugCollision === null,
      primaryDomainAvailable: state.domainCollision === null,
      staffEmailsAvailable: state.staffEmailCollisions.length === 0,
    },
    collisions: {
      slug: state.slugCollision,
      primaryDomain: state.domainCollision,
      staffEmails: state.staffEmailCollisions,
    },
    bootstrapReady: state.ready,
    nextStep: state.ready
      ? "Review this plan, set both BOOTSTRAP_*_PASSWORD environment variables, then rerun tenant:bootstrap with --confirm."
      : "Resolve every reported collision before bootstrapping.",
  }, null, 2));
}

function readStrongPassword(environmentName: string) {
  const value = process.env[environmentName];
  if (!value) throw new Error(`${environmentName} must be set for tenant:bootstrap`);
  const result = bootstrapPasswordSchema.safeParse(value);
  if (!result.success) {
    const reasons = result.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`${environmentName} is invalid: ${reasons}`);
  }
  return result.data;
}

function collisionMessage(state: Awaited<ReturnType<typeof inspect>>) {
  const collisions = [];
  if (state.slugCollision) collisions.push(`tenant slug '${state.slugCollision.slug}'`);
  if (state.domainCollision) collisions.push(`primary domain '${state.domainCollision.domain}'`);
  for (const user of state.staffEmailCollisions) {
    collisions.push(`staff email '${user.email}' in tenant '${user.tenant}'`);
  }
  return collisions.join(", ");
}

async function bootstrap(config: TenantBootstrap, checksum: string) {
  if (!process.argv.includes("--confirm")) {
    throw new Error("Bootstrapping creates a tenant and privileged staff. Review tenant:plan and pass --confirm.");
  }

  const adminPassword = readStrongPassword("BOOTSTRAP_ADMIN_PASSWORD");
  const compliancePassword = readStrongPassword("BOOTSTRAP_COMPLIANCE_PASSWORD");
  if (adminPassword === compliancePassword) {
    throw new Error("BOOTSTRAP_ADMIN_PASSWORD and BOOTSTRAP_COMPLIANCE_PASSWORD must be distinct");
  }

  const preflight = await inspect(prisma, config);
  if (!preflight.ready) {
    throw new Error(`Tenant bootstrap refused because of existing ${collisionMessage(preflight)}`);
  }

  // Password hashing occurs before opening the write transaction. No password
  // or passwordHash field is ever included in CLI output or audit metadata.
  const [adminPasswordHash, compliancePasswordHash] = await Promise.all([
    bcrypt.hash(adminPassword, BOOTSTRAP_BCRYPT_COST),
    bcrypt.hash(compliancePassword, BOOTSTRAP_BCRYPT_COST),
  ]);

  const created = await prisma.$transaction(async (tx) => {
    const state = await inspect(tx, config);
    if (!state.ready) {
      throw new Error(`Tenant bootstrap refused because of existing ${collisionMessage(state)}`);
    }

    const tenant = await tx.tenant.create({ data: config.tenant });
    const administrator = await tx.user.create({
      data: {
        tenantId: tenant.id,
        name: config.initialStaff.administrator.name,
        email: config.initialStaff.administrator.email,
        normalizedEmail: config.initialStaff.administrator.email,
        passwordHash: adminPasswordHash,
        role: "ADMIN",
        status: "ACTIVE",
        emailVerifiedAt: new Date(config.initialStaff.administrator.mailboxVerification.verifiedAt),
      },
      select: { id: true, role: true },
    });
    const compliance = await tx.user.create({
      data: {
        tenantId: tenant.id,
        name: config.initialStaff.compliance.name,
        email: config.initialStaff.compliance.email,
        normalizedEmail: config.initialStaff.compliance.email,
        passwordHash: compliancePasswordHash,
        role: "COMPLIANCE",
        status: "ACTIVE",
        emailVerifiedAt: new Date(config.initialStaff.compliance.mailboxVerification.verifiedAt),
      },
      select: { id: true, role: true },
    });

    const audit = await tx.auditEvent.create({
      data: {
        tenantId: tenant.id,
        actorType: "SYSTEM",
        action: "TENANT_BOOTSTRAPPED",
        resourceType: "Tenant",
        resourceId: tenant.id,
        reason: "Explicitly confirmed initial tenant and privileged-staff bootstrap",
        metadataJson: JSON.stringify({
          schemaVersion: config.schemaVersion,
          manifestChecksum: checksum,
          initialStaff: [
            {
              ...administrator,
              mailboxVerification: config.initialStaff.administrator.mailboxVerification,
            },
            {
              ...compliance,
              mailboxVerification: config.initialStaff.compliance.mailboxVerification,
            },
          ],
        }),
      },
      select: { id: true },
    });

    return {
      tenant: { id: tenant.id, slug: tenant.slug },
      administrator,
      compliance,
      auditId: audit.id,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  console.log(JSON.stringify({
    created: true,
    manifestChecksum: checksum,
    ...created,
  }, null, 2));
}

async function main() {
  const command = process.argv[2];
  const file = process.argv[3];
  if (!command || !file || !["validate", "plan", "bootstrap"].includes(command)) usage();
  const loaded = await load(file);
  console.log(`Tenant bootstrap manifest valid: ${loaded.config.tenant.slug}`);
  console.log(`Manifest SHA-256: ${loaded.checksum}`);
  if (command === "validate") return;
  if (command === "plan") return printPlan(loaded.config, loaded.checksum);
  return bootstrap(loaded.config, loaded.checksum);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Tenant bootstrap failed");
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
