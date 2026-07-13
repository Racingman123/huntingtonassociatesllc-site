import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { db } from "@/server/db";
import { createStaff } from "./fixtures";

function catalogOverlay(tenantSlug: string, marker: string) {
  return {
    schemaVersion: 1,
    targetTenantSlug: tenantSlug,
    releaseName: `Disposable catalog ${marker}`,
    currency: "USD",
    products: [
      {
        slug: `trail-kit-${marker}`,
        title: "Trail Kit",
        subtitle: null,
        description: "A disposable physical catalog product.",
        productType: "PHYSICAL",
        category: "Gear",
        priceCents: 5000,
        compareAtCents: null,
        image: "/demo/products/roadside-kit.svg",
        secondaryImage: null,
        badge: null,
        entryMultiplier: 2,
        featured: true,
        inventory: 10,
        tags: ["gear", "launch"],
        variants: [{
          sku: `KIT-${marker.toUpperCase()}`,
          title: "Default",
          options: {},
          priceCents: null,
          inventory: 10,
          status: "ACTIVE",
        }],
        subscriptionPlan: null,
      },
      {
        slug: `membership-${marker}`,
        title: "Test Membership",
        subtitle: "Monthly",
        description: "A disposable membership catalog product.",
        productType: "MEMBERSHIP",
        category: "Membership",
        priceCents: 2500,
        compareAtCents: null,
        image: "/demo/products/membership.svg",
        secondaryImage: null,
        badge: "MEMBER",
        entryMultiplier: 1,
        featured: false,
        inventory: 1000,
        tags: ["membership"],
        variants: [{
          sku: `MEMBER-${marker.toUpperCase()}`,
          title: "Monthly",
          options: { billing: "monthly" },
          priceCents: null,
          inventory: 1000,
          status: "ACTIVE",
        }],
        subscriptionPlan: {
          name: "Test Monthly",
          interval: "MONTH",
          intervalCount: 1,
          priceCents: 2500,
          currency: "USD",
          baseEntries: "25",
          providerPriceId: `price_test_${marker}`,
        },
      },
    ],
    collections: [{
      slug: `launch-${marker}`,
      title: "Launch",
      description: "Disposable ordered catalog collection.",
      image: "/demo/categories/new.svg",
      sortOrder: 0,
      productSlugs: [`membership-${marker}`, `trail-kit-${marker}`],
    }],
  };
}

function runCatalogCli(input: {
  overlay: unknown;
  command: "plan" | "apply";
  actorId?: string;
  confirm?: boolean;
}) {
  const directory = mkdtempSync(join(tmpdir(), "catalog-import-cli-"));
  const configPath = join(directory, "catalog.json");
  writeFileSync(configPath, JSON.stringify(input.overlay));
  try {
    const args = ["--import", "tsx", "scripts/catalog.ts", input.command, configPath];
    if (input.actorId) args.push("--actor", input.actorId);
    if (input.confirm) args.push("--confirm");
    const result = spawnSync(process.execPath, args, {
      cwd: resolve(import.meta.dirname, "../.."),
      env: process.env,
      encoding: "utf8",
      timeout: 20_000,
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

describe("catalog import CLI", () => {
  test("plans and atomically creates a new catalog, then refuses identifier collisions", async () => {
    const marker = randomUUID().slice(0, 8);
    const tenant = await db.tenant.create({
      data: {
        slug: `catalog-${marker}`,
        displayName: "Catalog test",
        legalName: "Catalog Test LLC",
        supportEmail: `catalog-${marker}@example.test`,
        currency: "USD",
      },
    });
    const actor = await createStaff(tenant.id, "ADMIN");
    const overlay = catalogOverlay(tenant.slug, marker);

    const plan = runCatalogCli({ overlay, command: "plan" });
    expect(plan.status, plan.output).toBe(0);
    expect(plan.output).toMatch(/"applyReady": true/);
    expect(await db.product.count({ where: { tenantId: tenant.id } })).toBe(0);

    const missingConfirmation = runCatalogCli({ overlay, command: "apply", actorId: actor.id });
    expect(missingConfirmation.status).not.toBe(0);
    expect(missingConfirmation.output).toMatch(/pass --confirm/i);
    expect(await db.product.count({ where: { tenantId: tenant.id } })).toBe(0);

    const applied = runCatalogCli({ overlay, command: "apply", actorId: actor.id, confirm: true });
    expect(applied.status, applied.output).toBe(0);
    expect(applied.output).toMatch(/Catalog imported: 2 products, 2 variants, 1 collections/);

    const created = await db.product.findMany({
      where: { tenantId: tenant.id },
      orderBy: { slug: "asc" },
      include: { variants: true, subscriptionPlan: true },
    });
    expect(created).toHaveLength(2);
    expect(created.find((product) => product.productType === "MEMBERSHIP")?.subscriptionPlan).toMatchObject({
      interval: "MONTH",
      priceCents: 2500,
      currency: "USD",
      baseEntries: 25n,
      providerPriceId: `price_test_${marker}`,
    });
    expect(created.flatMap((product) => product.variants)).toHaveLength(2);

    const collection = await db.collection.findFirstOrThrow({
      where: { tenantId: tenant.id },
      include: { products: { orderBy: { sortOrder: "asc" }, include: { product: true } } },
    });
    expect(collection.products.map((membership) => membership.product.slug)).toEqual([
      `membership-${marker}`,
      `trail-kit-${marker}`,
    ]);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: tenant.id, action: "CATALOG_OVERLAY_IMPORTED" },
    });
    expect(audit.actorId).toBe(actor.id);
    expect(JSON.parse(audit.metadataJson)).toMatchObject({
      productCount: 2,
      variantCount: 2,
      subscriptionPlanCount: 1,
      collectionCount: 1,
    });

    const collision = runCatalogCli({ overlay, command: "apply", actorId: actor.id, confirm: true });
    expect(collision.status).not.toBe(0);
    expect(collision.output).toMatch(/not ready|collision/i);
    expect(await db.product.count({ where: { tenantId: tenant.id } })).toBe(2);
    expect(await db.collection.count({ where: { tenantId: tenant.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: tenant.id, action: "CATALOG_OVERLAY_IMPORTED" } })).toBe(1);
  });
});
