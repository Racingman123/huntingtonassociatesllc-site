import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { themeContrastIssues } from "../src/theme/contrast";
import { themeConfigSchema } from "../src/theme/schema";
import { isTwoDecimalCurrency } from "../src/lib/format";

const prisma = new PrismaClient();
const hostname = z.string().trim().toLowerCase().max(253).refine((value) => (
  value === "localhost"
  || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
), "Use a hostname without a scheme, port, path, or wildcard");

const brandOverlaySchema = z.object({
  schemaVersion: z.literal(1),
  targetTenantSlug: z.string().trim().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  tenant: z.object({
    displayName: z.string().trim().min(1).max(100),
    legalName: z.string().trim().min(1).max(180),
    supportEmail: z.email().trim().toLowerCase(),
    primaryDomain: hostname,
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).refine(
      isTwoDecimalCurrency,
      "Commerce currently requires an ISO currency with exactly two minor-unit digits",
    ),
    timezone: z.string().trim().min(1).max(100).refine((value) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
        return true;
      } catch {
        return false;
      }
    }, "Use an IANA timezone such as America/New_York"),
    flatShippingCents: z.number().int().min(0).max(10_000_000),
    freeShippingThresholdCents: z.number().int().min(0).max(100_000_000),
  }),
  themeReleaseName: z.string().trim().min(1).max(120),
  theme: themeConfigSchema,
}).superRefine((value, context) => {
  if (value.tenant.displayName !== value.theme.brand.displayName) {
    context.addIssue({
      code: "custom",
      path: ["theme", "brand", "displayName"],
      message: "Theme and tenant display names must match",
    });
  }
});

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  npm run brand:validate -- config/brand.example.json",
    "  npm run brand:plan -- config/brand.example.json",
    "  npm run brand:apply -- config/brand.example.json --actor <active-admin-user-id> --confirm",
  ].join("\n"));
}

async function loadOverlay(file: string) {
  const parsed = brandOverlaySchema.parse(JSON.parse(await readFile(resolve(file), "utf8")));
  const contrast = themeContrastIssues(parsed.theme);
  if (contrast.length) {
    throw new Error(`Theme fails WCAG AA checks:\n${contrast.map((issue) => (
      `- ${issue.pair}: ${issue.ratio.toFixed(2)}:1 (minimum ${issue.minimum}:1)`
    )).join("\n")}`);
  }
  const configJson = JSON.stringify(parsed.theme);
  return { overlay: parsed, configJson, checksum: sha256(configJson) };
}

async function tenantState(slug: string) {
  return prisma.tenant.findFirst({
    where: { slug, status: "ACTIVE" },
    include: {
      themes: {
        where: { status: "PUBLISHED" },
        orderBy: { version: "desc" },
        take: 1,
      },
    },
  });
}

async function main() {
  const command = process.argv[2];
  const file = process.argv[3];
  if (!command || !file || !["validate", "plan", "apply"].includes(command)) usage();
  const loaded = await loadOverlay(file);
  console.log(`Brand overlay valid: ${loaded.overlay.tenant.displayName}`);
  console.log(`Theme SHA-256: ${loaded.checksum}`);
  if (command === "validate") return;

  const existing = await tenantState(loaded.overlay.targetTenantSlug);
  if (!existing) throw new Error(`Active tenant '${loaded.overlay.targetTenantSlug}' not found`);
  console.log("Planned tenant identity:");
  console.log(JSON.stringify({
    before: {
      displayName: existing.displayName,
      legalName: existing.legalName,
      supportEmail: existing.supportEmail,
      primaryDomain: existing.primaryDomain,
      currency: existing.currency,
      timezone: existing.timezone,
      flatShippingCents: existing.flatShippingCents,
      freeShippingThresholdCents: existing.freeShippingThresholdCents,
      themeChecksum: existing.themes[0]?.checksum ?? null,
    },
    after: {
      ...loaded.overlay.tenant,
      themeChecksum: loaded.checksum,
      themeReleaseName: loaded.overlay.themeReleaseName,
    },
  }, null, 2));
  if (command === "plan") return;
  if (!process.argv.includes("--confirm")) {
    throw new Error("Applying an overlay changes tenant-visible identity and theme. Review brand:plan and pass --confirm.");
  }
  const actorId = option("--actor");
  if (!actorId) usage();
  const actor = await prisma.user.findFirst({
    where: { id: actorId, tenantId: existing.id, status: "ACTIVE", role: "ADMIN" },
    select: { id: true },
  });
  if (!actor) throw new Error("--actor must identify an active ADMIN in the target tenant");

  const result = await prisma.$transaction(async (tx) => {
    const latest = await tx.themeVersion.aggregate({
      where: { tenantId: existing.id },
      _max: { version: true },
    });
    const current = await tx.themeVersion.findFirst({
      where: { tenantId: existing.id, status: "PUBLISHED" },
      orderBy: { version: "desc" },
    });
    await tx.tenant.update({
      where: { id: existing.id },
      data: loaded.overlay.tenant,
    });
    let theme = current;
    if (current?.checksum !== loaded.checksum) {
      await tx.themeVersion.updateMany({
        where: { tenantId: existing.id, status: "PUBLISHED" },
        data: { status: "SUPERSEDED" },
      });
      theme = await tx.themeVersion.create({
        data: {
          tenantId: existing.id,
          version: (latest._max.version ?? 0) + 1,
          status: "PUBLISHED",
          name: loaded.overlay.themeReleaseName,
          configJson: loaded.configJson,
          checksum: loaded.checksum,
          publishedAt: new Date(),
        },
      });
    }
    await tx.auditEvent.create({
      data: {
        tenantId: existing.id,
        actorType: "ADMIN",
        actorId: actor.id,
        action: "BRAND_OVERLAY_APPLIED",
        resourceType: "Tenant",
        resourceId: existing.id,
        metadataJson: JSON.stringify({
          themeVersion: theme?.version ?? null,
          themeChecksum: loaded.checksum,
          identityChanged: existing.displayName !== loaded.overlay.tenant.displayName
            || existing.legalName !== loaded.overlay.tenant.legalName
            || existing.primaryDomain !== loaded.overlay.tenant.primaryDomain,
        }),
      },
    });
    return theme;
  });
  console.log(`Overlay applied. Published theme version: ${result?.version ?? "unchanged"}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
