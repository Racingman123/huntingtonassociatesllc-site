import { createHash } from "node:crypto";
import { z } from "zod";
import { isTwoDecimalCurrency } from "@/lib/format";
import { billingIntervals } from "@/server/subscriptions/calculation";

const slug = z.string().trim().min(1).max(100).regex(
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  "Use lowercase words separated by hyphens",
);
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).refine(
  isTwoDecimalCurrency,
  "Use an ISO currency with exactly two minor-unit digits",
);
const cents = z.number().int().nonnegative().max(2_000_000_000);
const inventory = z.number().int().nonnegative().max(2_000_000_000);
const publicAssetPath = z.string().trim().min(1).max(500).refine((value) => (
  value.startsWith("/")
  && !value.startsWith("//")
  && !value.split(/[?#]/, 1)[0]!.split("/").includes("..")
), "Use a root-relative public asset path without traversal segments");
const sku = z.string().trim().min(1).max(100).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
  "Use letters, numbers, dots, underscores, colons, slashes, or hyphens",
);
const nonNegativeBigIntString = z.string().trim().regex(/^\d+$/, "Use a non-negative whole number").refine(
  (value) => {
    try {
      return BigInt(value) <= BigInt("9223372036854775807");
    } catch {
      return false;
    }
  },
  "Value exceeds the signed 64-bit database limit",
);

const variantSchema = z.object({
  sku,
  title: z.string().trim().min(1).max(160),
  options: z.record(
    z.string().trim().min(1).max(80),
    z.string().trim().min(1).max(160),
  ).default({}).refine((value) => Object.keys(value).length <= 20, "Use no more than 20 variant options"),
  priceCents: cents.nullable().default(null),
  inventory,
  status: z.literal("ACTIVE").default("ACTIVE"),
}).strict();

const subscriptionPlanSchema = z.object({
  name: z.string().trim().min(1).max(160),
  interval: z.enum(billingIntervals),
  intervalCount: z.number().int().positive().max(1_000),
  priceCents: cents.refine((value) => value > 0, "Membership price must be positive"),
  currency,
  baseEntries: nonNegativeBigIntString,
  providerPriceId: z.string().trim().min(1).max(255).nullable(),
}).strict();

const productSchema = z.object({
  slug,
  title: z.string().trim().min(1).max(180),
  subtitle: z.string().trim().min(1).max(240).nullable().default(null),
  description: z.string().trim().min(1).max(20_000),
  productType: z.enum(["PHYSICAL", "DIGITAL", "MEMBERSHIP"]),
  category: z.string().trim().min(1).max(120),
  priceCents: cents,
  compareAtCents: cents.nullable().default(null),
  image: publicAssetPath,
  secondaryImage: publicAssetPath.nullable().default(null),
  badge: z.string().trim().min(1).max(80).nullable().default(null),
  entryMultiplier: z.number().int().positive().max(1_000_000).default(1),
  featured: z.boolean().default(false),
  inventory,
  tags: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
  variants: z.array(variantSchema).min(1).max(1_000),
  subscriptionPlan: subscriptionPlanSchema.nullable().default(null),
}).strict().superRefine((product, context) => {
  if (product.compareAtCents !== null && product.compareAtCents <= product.priceCents) {
    context.addIssue({
      code: "custom",
      path: ["compareAtCents"],
      message: "Compare-at price must be greater than the current product price",
    });
  }
  if (product.productType === "MEMBERSHIP" && !product.subscriptionPlan) {
    context.addIssue({
      code: "custom",
      path: ["subscriptionPlan"],
      message: "Every MEMBERSHIP product requires exactly one subscription plan",
    });
  }
  if (product.productType !== "MEMBERSHIP" && product.subscriptionPlan) {
    context.addIssue({
      code: "custom",
      path: ["subscriptionPlan"],
      message: "Ordinary products must not define a subscription plan",
    });
  }
  if (product.subscriptionPlan && product.subscriptionPlan.priceCents !== product.priceCents) {
    context.addIssue({
      code: "custom",
      path: ["subscriptionPlan", "priceCents"],
      message: "Subscription and storefront product prices must match",
    });
  }
  if (
    product.productType === "PHYSICAL"
    && product.inventory !== product.variants.reduce((total, variant) => total + variant.inventory, 0)
  ) {
    context.addIssue({
      code: "custom",
      path: ["inventory"],
      message: "Physical product inventory must equal the sum of its active variant inventory",
    });
  }

  const optionSignatures = new Set<string>();
  for (const [index, variant] of product.variants.entries()) {
    const signature = stableJson(variant.options);
    if (optionSignatures.has(signature)) {
      context.addIssue({
        code: "custom",
        path: ["variants", index, "options"],
        message: "Active variants within a product must have unique option combinations",
      });
    }
    optionSignatures.add(signature);
  }

  const normalizedTags = new Set<string>();
  for (const [index, tag] of product.tags.entries()) {
    const normalized = tag.toLocaleLowerCase("en-US");
    if (normalizedTags.has(normalized)) {
      context.addIssue({
        code: "custom",
        path: ["tags", index],
        message: "Product tags must be unique ignoring case",
      });
    }
    normalizedTags.add(normalized);
  }
});

const collectionSchema = z.object({
  slug,
  title: z.string().trim().min(1).max(180),
  description: z.string().trim().min(1).max(5_000),
  image: publicAssetPath.nullable().default(null),
  sortOrder: z.number().int().min(0).max(100_000),
  productSlugs: z.array(slug).min(1).max(10_000),
}).strict();

export const catalogOverlaySchema = z.object({
  schemaVersion: z.literal(1),
  targetTenantSlug: slug,
  releaseName: z.string().trim().min(1).max(160),
  currency,
  products: z.array(productSchema).min(1).max(10_000),
  collections: z.array(collectionSchema).max(1_000).default([]),
}).strict().superRefine((overlay, context) => {
  const productSlugs = new Set<string>();
  const skus = new Set<string>();
  const providerPriceIds = new Set<string>();

  for (const [productIndex, product] of overlay.products.entries()) {
    if (productSlugs.has(product.slug)) {
      context.addIssue({
        code: "custom",
        path: ["products", productIndex, "slug"],
        message: `Duplicate product slug ${product.slug}`,
      });
    }
    productSlugs.add(product.slug);

    if (product.subscriptionPlan?.currency !== undefined
      && product.subscriptionPlan.currency !== overlay.currency) {
      context.addIssue({
        code: "custom",
        path: ["products", productIndex, "subscriptionPlan", "currency"],
        message: "Subscription plan currency must match the catalog currency",
      });
    }
    const providerPriceId = product.subscriptionPlan?.providerPriceId;
    if (providerPriceId) {
      if (providerPriceIds.has(providerPriceId)) {
        context.addIssue({
          code: "custom",
          path: ["products", productIndex, "subscriptionPlan", "providerPriceId"],
          message: `Duplicate provider price id ${providerPriceId}`,
        });
      }
      providerPriceIds.add(providerPriceId);
    }

    for (const [variantIndex, variant] of product.variants.entries()) {
      const normalizedSku = variant.sku.toLocaleUpperCase("en-US");
      if (skus.has(normalizedSku)) {
        context.addIssue({
          code: "custom",
          path: ["products", productIndex, "variants", variantIndex, "sku"],
          message: `Duplicate SKU ${variant.sku} (SKU uniqueness is case-insensitive)`,
        });
      }
      skus.add(normalizedSku);
    }
  }

  const collectionSlugs = new Set<string>();
  for (const [collectionIndex, collection] of overlay.collections.entries()) {
    if (collectionSlugs.has(collection.slug)) {
      context.addIssue({
        code: "custom",
        path: ["collections", collectionIndex, "slug"],
        message: `Duplicate collection slug ${collection.slug}`,
      });
    }
    collectionSlugs.add(collection.slug);

    const members = new Set<string>();
    for (const [memberIndex, productSlug] of collection.productSlugs.entries()) {
      if (!productSlugs.has(productSlug)) {
        context.addIssue({
          code: "custom",
          path: ["collections", collectionIndex, "productSlugs", memberIndex],
          message: `Collection references unknown product slug ${productSlug}`,
        });
      }
      if (members.has(productSlug)) {
        context.addIssue({
          code: "custom",
          path: ["collections", collectionIndex, "productSlugs", memberIndex],
          message: `Collection contains product ${productSlug} more than once`,
        });
      }
      members.add(productSlug);
    }
  }
});

export type CatalogOverlay = z.infer<typeof catalogOverlaySchema>;

export function parseCatalogOverlay(value: unknown) {
  return catalogOverlaySchema.parse(value);
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

export function catalogOverlayChecksum(overlay: CatalogOverlay) {
  return createHash("sha256").update(stableJson(overlay)).digest("hex");
}
