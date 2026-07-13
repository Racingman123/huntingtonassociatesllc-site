import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  catalogOverlayChecksum,
  parseCatalogOverlay,
  stableJson,
  type CatalogOverlay,
} from "../src/server/catalog/overlay";

const prisma = new PrismaClient();

type CatalogClient = Pick<
  Prisma.TransactionClient,
  "tenant" | "product" | "productVariant" | "collection" | "subscriptionPlan"
>;

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  npm run catalog:validate -- config/catalog.example.json",
    "  npm run catalog:plan -- config/catalog.example.json",
    "  npm run catalog:apply -- config/catalog.example.json --actor <active-admin-user-id> --confirm",
  ].join("\n"));
}

async function loadOverlay(file: string) {
  let input: unknown;
  try {
    input = JSON.parse(await readFile(resolve(file), "utf8"));
  } catch (error) {
    throw new Error(`Unable to read catalog JSON: ${error instanceof Error ? error.message : "invalid input"}`);
  }
  const overlay = parseCatalogOverlay(input);
  return { overlay, checksum: catalogOverlayChecksum(overlay) };
}

async function inspectState(client: CatalogClient, overlay: CatalogOverlay) {
  const tenant = await client.tenant.findFirst({
    where: { slug: overlay.targetTenantSlug, status: "ACTIVE" },
    select: { id: true, slug: true, currency: true },
  });
  if (!tenant) throw new Error(`Active tenant '${overlay.targetTenantSlug}' not found`);

  const requestedProductSlugs = new Set(overlay.products.map((product) => product.slug));
  const requestedCollectionSlugs = new Set(overlay.collections.map((collection) => collection.slug));
  const requestedSkus = new Set(overlay.products.flatMap((product) => (
    product.variants.map((variant) => variant.sku.toLocaleUpperCase("en-US"))
  )));
  const requestedProviderPrices = new Set(overlay.products.flatMap((product) => {
    const id = product.subscriptionPlan?.providerPriceId;
    return id ? [id] : [];
  }));

  // Read all identifiers for the tenant so case-only differences cannot bypass
  // the importer's stricter, operator-friendly identifier policy on SQLite.
  const [products, variants, collections, plans] = await Promise.all([
    client.product.findMany({
      where: { tenantId: tenant.id },
      select: { id: true, slug: true, title: true, orderLines: { select: { id: true }, take: 1 } },
    }),
    client.productVariant.findMany({
      where: { tenantId: tenant.id },
      select: { id: true, sku: true, product: { select: { slug: true } } },
    }),
    client.collection.findMany({
      where: { tenantId: tenant.id },
      select: { id: true, slug: true, title: true },
    }),
    client.subscriptionPlan.findMany({
      where: { tenantId: tenant.id, providerPriceId: { not: null } },
      select: { id: true, providerPriceId: true, product: { select: { slug: true } } },
    }),
  ]);

  const productCollisions = products.filter((product) => (
    requestedProductSlugs.has(product.slug.toLocaleLowerCase("en-US"))
  ));
  const skuCollisions = variants.filter((variant) => (
    requestedSkus.has(variant.sku.toLocaleUpperCase("en-US"))
  ));
  const collectionCollisions = collections.filter((collection) => (
    requestedCollectionSlugs.has(collection.slug.toLocaleLowerCase("en-US"))
  ));
  const providerPriceCollisions = plans.filter((plan) => (
    plan.providerPriceId !== null && requestedProviderPrices.has(plan.providerPriceId)
  ));

  const checks = {
    tenantCurrency: {
      ready: tenant.currency === overlay.currency,
      configured: overlay.currency,
      tenant: tenant.currency,
    },
    productSlugCollisions: {
      ready: productCollisions.length === 0,
      collisions: productCollisions.map((product) => ({
        id: product.id,
        slug: product.slug,
        title: product.title,
        hasOrderHistory: product.orderLines.length > 0,
      })),
    },
    skuCollisions: {
      ready: skuCollisions.length === 0,
      collisions: skuCollisions.map((variant) => ({
        id: variant.id,
        sku: variant.sku,
        productSlug: variant.product.slug,
      })),
    },
    collectionSlugCollisions: {
      ready: collectionCollisions.length === 0,
      collisions: collectionCollisions.map((collection) => ({
        id: collection.id,
        slug: collection.slug,
        title: collection.title,
      })),
    },
    providerPriceIdCollisions: {
      ready: providerPriceCollisions.length === 0,
      collisions: providerPriceCollisions.map((plan) => ({
        id: plan.id,
        providerPriceId: plan.providerPriceId,
        productSlug: plan.product.slug,
      })),
    },
  };
  return {
    tenant,
    checks,
    applyReady: Object.values(checks).every((check) => check.ready),
    existingCatalog: {
      products: products.length,
      variants: variants.length,
      collections: collections.length,
    },
  };
}

function planOutput(overlay: CatalogOverlay, checksum: string, state: Awaited<ReturnType<typeof inspectState>>) {
  return {
    tenant: state.tenant.slug,
    releaseName: overlay.releaseName,
    catalogChecksum: checksum,
    creates: {
      products: overlay.products.length,
      variants: overlay.products.reduce((total, product) => total + product.variants.length, 0),
      subscriptionPlans: overlay.products.filter((product) => product.subscriptionPlan !== null).length,
      collections: overlay.collections.length,
      collectionMemberships: overlay.collections.reduce(
        (total, collection) => total + collection.productSlugs.length,
        0,
      ),
    },
    existingCatalog: state.existingCatalog,
    checks: state.checks,
    applyReady: state.applyReady,
  };
}

async function printPlan(overlay: CatalogOverlay, checksum: string) {
  const state = await inspectState(prisma, overlay);
  console.log(JSON.stringify(planOutput(overlay, checksum, state), null, 2));
  return state;
}

function assertReady(state: Awaited<ReturnType<typeof inspectState>>) {
  if (!state.applyReady) {
    throw new Error("Catalog import is not ready. Resolve every collision and currency mismatch shown by catalog:plan.");
  }
}

async function applyOverlay(overlay: CatalogOverlay, checksum: string) {
  if (!process.argv.includes("--confirm")) {
    throw new Error("Importing creates a tenant-visible catalog. Review catalog:plan and pass --confirm.");
  }
  const actorId = option("--actor");
  if (!actorId) usage();

  const result = await prisma.$transaction(async (tx) => {
    const state = await inspectState(tx, overlay);
    assertReady(state);
    const actor = await tx.user.findFirst({
      where: {
        id: actorId,
        tenantId: state.tenant.id,
        status: "ACTIVE",
        role: "ADMIN",
      },
      select: { id: true },
    });
    if (!actor) throw new Error("--actor must identify an active ADMIN in the target tenant");

    const productIds = new Map<string, string>();
    let variantCount = 0;
    let planCount = 0;
    for (const product of overlay.products) {
      const plan = product.subscriptionPlan;
      const created = await tx.product.create({
        data: {
          tenantId: state.tenant.id,
          slug: product.slug,
          title: product.title,
          subtitle: product.subtitle,
          description: product.description,
          productType: product.productType,
          status: "ACTIVE",
          category: product.category,
          priceCents: product.priceCents,
          compareAtCents: product.compareAtCents,
          image: product.image,
          secondaryImage: product.secondaryImage,
          badge: product.badge,
          entryMultiplier: product.entryMultiplier,
          featured: product.featured,
          inventory: product.inventory,
          tagsJson: JSON.stringify(product.tags),
          variants: {
            create: product.variants.map((variant) => ({
              tenantId: state.tenant.id,
              sku: variant.sku,
              title: variant.title,
              optionJson: stableJson(variant.options),
              priceCents: variant.priceCents,
              inventory: variant.inventory,
              status: "ACTIVE",
            })),
          },
          ...(plan ? {
            subscriptionPlan: {
              create: {
                tenantId: state.tenant.id,
                name: plan.name,
                status: "ACTIVE",
                interval: plan.interval,
                intervalCount: plan.intervalCount,
                priceCents: plan.priceCents,
                currency: plan.currency,
                baseEntries: BigInt(plan.baseEntries),
                providerPriceId: plan.providerPriceId,
              },
            },
          } : {}),
        },
        select: { id: true },
      });
      productIds.set(product.slug, created.id);
      variantCount += product.variants.length;
      if (plan) planCount += 1;
    }

    let membershipCount = 0;
    for (const collection of overlay.collections) {
      const created = await tx.collection.create({
        data: {
          tenantId: state.tenant.id,
          slug: collection.slug,
          title: collection.title,
          description: collection.description,
          image: collection.image,
          sortOrder: collection.sortOrder,
        },
        select: { id: true },
      });
      await tx.productCollection.createMany({
        data: collection.productSlugs.map((productSlug, sortOrder) => ({
          productId: productIds.get(productSlug)!,
          collectionId: created.id,
          sortOrder,
        })),
      });
      membershipCount += collection.productSlugs.length;
    }

    await tx.auditEvent.create({
      data: {
        tenantId: state.tenant.id,
        actorType: "ADMIN",
        actorId: actor.id,
        action: "CATALOG_OVERLAY_IMPORTED",
        resourceType: "TenantCatalog",
        resourceId: state.tenant.id,
        reason: overlay.releaseName,
        metadataJson: JSON.stringify({
          schemaVersion: overlay.schemaVersion,
          catalogChecksum: checksum,
          currency: overlay.currency,
          productCount: productIds.size,
          variantCount,
          subscriptionPlanCount: planCount,
          collectionCount: overlay.collections.length,
          collectionMembershipCount: membershipCount,
        }),
      },
    });

    return {
      products: productIds.size,
      variants: variantCount,
      subscriptionPlans: planCount,
      collections: overlay.collections.length,
      collectionMemberships: membershipCount,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  console.log(`Catalog imported: ${result.products} products, ${result.variants} variants, ${result.collections} collections.`);
  console.log(`Catalog SHA-256: ${checksum}`);
}

async function main() {
  const command = process.argv[2];
  const file = process.argv[3];
  if (!command || !file || !["validate", "plan", "apply"].includes(command)) usage();
  const loaded = await loadOverlay(file);
  console.log(`Catalog overlay valid: ${loaded.overlay.releaseName}`);
  console.log(`Catalog SHA-256: ${loaded.checksum}`);
  if (command === "validate") return;
  if (command === "plan") {
    await printPlan(loaded.overlay, loaded.checksum);
    return;
  }
  await applyOverlay(loaded.overlay, loaded.checksum);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
