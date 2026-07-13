import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { parseThemeConfig } from "../src/theme/schema";
import { themeContrastIssues } from "../src/theme/contrast";

const prisma = new PrismaClient();

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  npm run theme:validate -- path/to/theme.json",
    "  npm run theme:publish -- path/to/theme.json --tenant tenant-slug --name 'Release name' --actor operator-id --confirm",
  ].join("\n"));
}

async function loadTheme(file: string) {
  const raw = await readFile(resolve(file), "utf8");
  const theme = parseThemeConfig(JSON.parse(raw));
  const issues = themeContrastIssues(theme);
  if (issues.length) {
    throw new Error(`Theme fails WCAG AA text-pair checks:\n${issues.map((issue) => (
      `- ${issue.pair}: ${issue.ratio.toFixed(2)}:1 (minimum ${issue.minimum}:1)`
    )).join("\n")}`);
  }
  const configJson = JSON.stringify(theme);
  const checksum = createHash("sha256").update(configJson).digest("hex");
  return { theme, configJson, checksum };
}

async function main() {
  const command = process.argv[2];
  const file = process.argv[3];
  if (!command || !file || !["validate", "publish"].includes(command)) usage();

  const loaded = await loadTheme(file);
  if (command === "validate") {
    console.log(`Theme valid: ${loaded.theme.brand.displayName}`);
    console.log(`SHA-256: ${loaded.checksum}`);
    return;
  }

  if (!process.argv.includes("--confirm")) {
    throw new Error("Publishing changes tenant-visible state. Review the preview and pass --confirm.");
  }
  const tenantSlug = option("--tenant");
  const name = option("--name");
  const actorId = option("--actor");
  if (!tenantSlug || !name || !actorId) usage();
  if (name.trim().length < 1 || name.trim().length > 120) {
    throw new Error("Theme release name must contain 1 to 120 characters");
  }

  const tenant = await prisma.tenant.findFirst({ where: { slug: tenantSlug, status: "ACTIVE" } });
  if (!tenant) throw new Error(`Active tenant '${tenantSlug}' not found`);
  const actor = await prisma.user.findFirst({
    where: { id: actorId, tenantId: tenant.id, status: "ACTIVE", role: "ADMIN" },
    select: { id: true },
  });
  if (!actor) throw new Error("--actor must identify an active ADMIN in the target tenant");
  const same = await prisma.themeVersion.findFirst({
    where: { tenantId: tenant.id, status: "PUBLISHED", checksum: loaded.checksum },
  });
  if (same) {
    console.log(`Theme v${same.version} is already published with checksum ${same.checksum}.`);
    return;
  }

  const published = await prisma.$transaction(async (tx) => {
    const latest = await tx.themeVersion.aggregate({
      where: { tenantId: tenant.id },
      _max: { version: true },
    });
    const version = (latest._max.version ?? 0) + 1;
    await tx.themeVersion.updateMany({
      where: { tenantId: tenant.id, status: "PUBLISHED" },
      data: { status: "SUPERSEDED" },
    });
    const created = await tx.themeVersion.create({
      data: {
        tenantId: tenant.id,
        version,
        status: "PUBLISHED",
        name: name.trim(),
        configJson: loaded.configJson,
        checksum: loaded.checksum,
        publishedAt: new Date(),
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: tenant.id,
        actorType: "ADMIN",
        actorId: actor.id,
        action: "THEME_PUBLISHED",
        resourceType: "ThemeVersion",
        resourceId: created.id,
        metadataJson: JSON.stringify({ version, checksum: loaded.checksum, name: name.trim() }),
      },
    });
    return created;
  });
  console.log(`Published theme v${published.version}: ${published.name}`);
  console.log(`SHA-256: ${published.checksum}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
