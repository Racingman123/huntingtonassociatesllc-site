import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  legalBodyChecksum,
  legalReleaseChecksum,
  parseLegalRelease,
  type LegalRelease,
} from "../src/server/legal/overlay";

const prisma = new PrismaClient();

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  npm run legal:validate -- config/legal.example.json",
    "  npm run legal:plan -- config/legal.example.json",
    "  npm run legal:publish -- config/legal.example.json --actor <active-admin-id> --witness <active-compliance-id> --confirm",
  ].join("\n"));
}

async function load(file: string) {
  const release = parseLegalRelease(JSON.parse(await readFile(resolve(file), "utf8")));
  return { release, checksum: legalReleaseChecksum(release) };
}

async function inspect(release: LegalRelease) {
  const tenant = await prisma.tenant.findFirst({
    where: { slug: release.targetTenantSlug, status: "ACTIVE" },
    select: { id: true, slug: true },
  });
  if (!tenant) throw new Error(`Active tenant '${release.targetTenantSlug}' not found`);
  const existing = await prisma.legalDocument.findMany({
    where: {
      tenantId: tenant.id,
      OR: release.documents.flatMap((document) => [
        { kind: document.kind, version: document.version },
        { slug: document.slug, version: document.version },
      ]),
    },
    select: { id: true, kind: true, slug: true, version: true, checksum: true, status: true },
  });
  const maxima = await prisma.legalDocument.findMany({
    where: { tenantId: tenant.id, kind: { in: [...new Set(release.documents.map((document) => document.kind))] } },
    select: { kind: true, version: true },
  });
  const maximumByKind = new Map<string, number>();
  for (const document of maxima) {
    maximumByKind.set(document.kind, Math.max(maximumByKind.get(document.kind) ?? 0, document.version));
  }
  return { tenant, existing, maximumByKind };
}

async function printPlan(release: LegalRelease, checksum: string) {
  const state = await inspect(release);
  const documents = release.documents.map((document) => {
    const collisions = state.existing.filter((existing) => (
      existing.version === document.version
      && (existing.kind === document.kind || existing.slug === document.slug)
    ));
    const expectedVersion = (state.maximumByKind.get(document.kind) ?? 0) + 1;
    return {
      kind: document.kind,
      slug: document.slug,
      version: document.version,
      expectedVersion,
      bodyChecksum: legalBodyChecksum(document.body),
      ready: collisions.length === 0 && document.version === expectedVersion,
      collisions,
    };
  });
  console.log(JSON.stringify({
    tenant: state.tenant.slug,
    releaseName: release.releaseName,
    releaseChecksum: checksum,
    documents,
    publishReady: documents.every((document) => document.ready),
  }, null, 2));
}

async function publish(release: LegalRelease, releaseChecksum: string) {
  if (!process.argv.includes("--confirm")) {
    throw new Error("Publishing creates immutable public legal versions. Review legal:plan and pass --confirm.");
  }
  const actorId = option("--actor");
  const witnessId = option("--witness");
  if (!actorId || !witnessId) usage();
  if (actorId === witnessId) throw new Error("--actor and --witness must identify distinct people");

  const created = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.findFirst({ where: { slug: release.targetTenantSlug, status: "ACTIVE" } });
    if (!tenant) throw new Error(`Active tenant '${release.targetTenantSlug}' not found`);
    const [actor, witness] = await Promise.all([
      tx.user.findFirst({ where: { id: actorId, tenantId: tenant.id, status: "ACTIVE", role: "ADMIN" }, select: { id: true } }),
      tx.user.findFirst({ where: { id: witnessId, tenantId: tenant.id, status: "ACTIVE", role: "COMPLIANCE" }, select: { id: true } }),
    ]);
    if (!actor) throw new Error("--actor must identify an active ADMIN in the target tenant");
    if (!witness) throw new Error("--witness must identify an active COMPLIANCE user in the target tenant");

    const output = [];
    for (const document of release.documents) {
      const latest = await tx.legalDocument.aggregate({
        where: { tenantId: tenant.id, kind: document.kind },
        _max: { version: true },
      });
      const expectedVersion = (latest._max.version ?? 0) + 1;
      if (document.version !== expectedVersion) {
        throw new Error(`${document.kind} must publish as version ${expectedVersion}`);
      }
      const collision = await tx.legalDocument.findFirst({
        where: {
          tenantId: tenant.id,
          version: document.version,
          OR: [{ kind: document.kind }, { slug: document.slug }],
        },
      });
      if (collision) throw new Error(`${document.kind} version ${document.version} already exists`);
      const bodyChecksum = legalBodyChecksum(document.body);
      const row = await tx.legalDocument.create({
        data: {
          tenantId: tenant.id,
          kind: document.kind,
          slug: document.slug,
          title: document.title,
          version: document.version,
          body: document.body,
          checksum: bodyChecksum,
          status: "PUBLISHED",
          effectiveAt: new Date(document.effectiveAt),
        },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: tenant.id,
          actorType: "ADMIN",
          actorId: actor.id,
          action: "LEGAL_DOCUMENT_PUBLISHED",
          resourceType: "LegalDocument",
          resourceId: row.id,
          reason: release.releaseName,
          metadataJson: JSON.stringify({
            kind: document.kind,
            version: document.version,
            bodyChecksum,
            releaseChecksum,
            complianceWitnessId: witness.id,
          }),
        },
      });
      output.push(row);
    }
    return output;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  console.log(`Published ${created.length} legal document version(s).`);
  for (const document of created) console.log(`${document.kind} v${document.version}: ${document.checksum}`);
  console.log(`Release SHA-256: ${releaseChecksum}`);
}

async function main() {
  const command = process.argv[2];
  const file = process.argv[3];
  if (!command || !file || !["validate", "plan", "publish"].includes(command)) usage();
  const loaded = await load(file);
  console.log(`Legal release valid: ${loaded.release.releaseName}`);
  console.log(`Release SHA-256: ${loaded.checksum}`);
  loaded.release.documents.forEach((document) => console.log(`${document.kind} v${document.version}: ${legalBodyChecksum(document.body)}`));
  if (command === "validate") return;
  if (command === "plan") return printPlan(loaded.release, loaded.checksum);
  return publish(loaded.release, loaded.checksum);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
