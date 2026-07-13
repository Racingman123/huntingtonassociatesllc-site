import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { db } from "./db";
import { defaultTheme } from "@/theme/default-theme";
import { parseThemeConfig } from "@/theme/schema";
import { DEFAULT_TENANT_SLUG } from "@/server/auth/config";
import { getRequestTenant } from "@/server/auth/tenant";
import { resolveConfiguredCampaignMultiplier } from "@/server/commerce/multiplier";
import { assertCampaignOfficialRules } from "@/lib/official-rules";

export { DEFAULT_TENANT_SLUG };

function withResolvedStorefrontMultiplier<T extends {
  status: string;
  startsAt: Date;
  endsAt: Date;
  currentMultiplier: number;
  multiplierSlots: Array<{
    id: string;
    label: string;
    numerator: number;
    denominator: number;
    startsAt: Date;
    endsAt: Date;
  }>;
}>(campaign: T, now = new Date()): T {
  if (campaign.status !== "LIVE" || now < campaign.startsAt || now >= campaign.endsAt) {
    return campaign;
  }
  const resolved = resolveConfiguredCampaignMultiplier({
    currentMultiplier: campaign.currentMultiplier,
    slots: campaign.multiplierSlots,
    at: now,
  });
  return { ...campaign, currentMultiplier: resolved.factor };
}

export const getTenant = cache(async (slug?: string) => {
  if (!slug) return getRequestTenant();
  const tenant = await db.tenant.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      status: true,
      displayName: true,
      legalName: true,
      supportEmail: true,
      primaryDomain: true,
      currency: true,
      timezone: true,
      flatShippingCents: true,
      freeShippingThresholdCents: true,
    },
  });
  if (!tenant || tenant.status !== "ACTIVE") notFound();
  return tenant;
});

export const getPublishedTheme = cache(async (tenantSlug?: string) => {
  const tenant = await getTenant(tenantSlug);
  const version = await db.themeVersion.findFirst({
    where: { tenantId: tenant.id, status: "PUBLISHED" },
    orderBy: { version: "desc" },
  });
  if (!version) return defaultTheme;
  try {
    return parseThemeConfig(JSON.parse(version.configJson));
  } catch {
    return defaultTheme;
  }
});

export const getNavigationCampaign = cache(async (tenantSlug?: string) => {
  const tenant = await getTenant(tenantSlug);
  const liveCampaign = await db.campaign.findFirst({
    where: { tenantId: tenant.id, status: "LIVE" },
    include: {
      prizes: { orderBy: { sortOrder: "asc" } },
      multiplierSlots: { orderBy: { startsAt: "asc" } },
      entryRules: { where: { active: true }, orderBy: [{ stackPriority: "asc" }, { id: "asc" }] },
      officialRulesDocument: true,
    },
    orderBy: { startsAt: "desc" },
  });
  if (liveCampaign) return liveCampaign;

  // Entry close must not make the entire storefront, account area, or staff
  // console disappear: the root layout also needs one campaign for its
  // navigation. Keep the latest public lifecycle visible while mutations
  // continue to enforce LIVE status and authoritative timestamps themselves.
  const latestPublicCampaign = await db.campaign.findFirst({
    where: {
      tenantId: tenant.id,
      status: { notIn: ["DRAFT", "IN_REVIEW", "APPROVED", "CANCELLED", "ARCHIVED"] },
    },
    include: {
      prizes: { orderBy: { sortOrder: "asc" } },
      multiplierSlots: { orderBy: { startsAt: "asc" } },
      entryRules: { where: { active: true }, orderBy: [{ stackPriority: "asc" }, { id: "asc" }] },
      officialRulesDocument: true,
    },
    orderBy: [{ startsAt: "desc" }, { id: "asc" }],
  });
  return latestPublicCampaign;
});

export const getActiveCampaign = cache(async (tenantSlug?: string) => {
  const tenant = await getTenant(tenantSlug);
  const liveCampaignCount = await db.campaign.count({
    where: { tenantId: tenant.id, status: "LIVE" },
  });
  if (liveCampaignCount > 1) {
    throw new Error("Tenant has multiple LIVE campaigns but storefront commerce supports exactly one");
  }
  const campaign = await getNavigationCampaign(tenantSlug);
  if (!campaign) notFound();
  return withResolvedStorefrontMultiplier(campaign);
});

export const getHomeData = cache(async (tenantSlug?: string) => {
  const tenant = await getTenant(tenantSlug);
  const [theme, campaign, products, collections, winners] = await Promise.all([
    getPublishedTheme(tenantSlug),
    getActiveCampaign(tenantSlug),
    db.product.findMany({
      where: {
        tenantId: tenant.id,
        status: "ACTIVE",
        featured: true,
        productType: { not: "MEMBERSHIP" },
        variants: { some: { status: "ACTIVE" } },
      },
      include: {
        variants: { where: { status: "ACTIVE" } },
        collections: { include: { collection: { select: { id: true, slug: true } } } },
      },
      orderBy: [{ category: "asc" }, { createdAt: "desc" }],
      take: 10,
    }),
    db.collection.findMany({
      where: { tenantId: tenant.id },
      orderBy: { sortOrder: "asc" },
    }),
    db.winner.findMany({
      where: { tenantId: tenant.id, status: "PUBLISHED" },
      include: { campaign: true, prize: true },
      orderBy: { publishedAt: "desc" },
      take: 6,
    }),
  ]);
  return { tenant, theme, campaign, products, collections, winners };
});

export const getAllProducts = cache(async (tenantSlug?: string) => {
  const tenant = await getTenant(tenantSlug);
  return db.product.findMany({
    where: {
      tenantId: tenant.id,
      status: "ACTIVE",
      productType: { not: "MEMBERSHIP" },
      variants: { some: { status: "ACTIVE" } },
    },
    include: {
      variants: { where: { status: "ACTIVE" }, orderBy: { title: "asc" } },
      collections: { include: { collection: { select: { id: true, slug: true } } } },
    },
    orderBy: [{ featured: "desc" }, { createdAt: "desc" }],
  });
});

export const getProduct = cache(async (slug: string, tenantSlug?: string) => {
  const tenant = await getTenant(tenantSlug);
  const product = await db.product.findUnique({
    where: { tenantId_slug: { tenantId: tenant.id, slug } },
    include: {
      variants: { where: { status: "ACTIVE" }, orderBy: { title: "asc" } },
      collections: { include: { collection: true } },
    },
  });
  if (
    !product
    || product.status !== "ACTIVE"
    || product.productType === "MEMBERSHIP"
    || product.variants.length === 0
  ) notFound();
  return product;
});

export const getCollection = cache(async (slug: string, tenantSlug?: string) => {
  const tenant = await getTenant(tenantSlug);
  const collection = await db.collection.findUnique({
    where: { tenantId_slug: { tenantId: tenant.id, slug } },
    include: {
      products: {
        where: {
          product: {
            status: "ACTIVE",
            productType: { not: "MEMBERSHIP" },
            variants: { some: { status: "ACTIVE" } },
          },
        },
        orderBy: { sortOrder: "asc" },
        include: {
          product: {
            include: {
              variants: { where: { status: "ACTIVE" } },
              collections: { include: { collection: { select: { id: true, slug: true } } } },
            },
          },
        },
      },
    },
  });
  if (!collection) notFound();
  return collection;
});

export const getCampaign = cache(async (slug: string, tenantSlug?: string) => {
  const tenant = await getTenant(tenantSlug);
  const campaign = await db.campaign.findFirst({
    where: {
      tenantId: tenant.id,
      slug,
      status: { notIn: ["DRAFT", "IN_REVIEW", "APPROVED", "CANCELLED", "ARCHIVED"] },
    },
    include: {
      prizes: { orderBy: { sortOrder: "asc" } },
      entryRules: { where: { active: true }, orderBy: { stackPriority: "asc" } },
      multiplierSlots: { orderBy: { startsAt: "asc" } },
      officialRulesDocument: true,
    },
  });
  if (!campaign) notFound();
  return withResolvedStorefrontMultiplier(campaign);
});

export const getPublishedWinners = cache(async (tenantSlug?: string) => {
  const tenant = await getTenant(tenantSlug);
  return db.winner.findMany({
    where: { tenantId: tenant.id, status: "PUBLISHED" },
    include: { campaign: true, prize: true },
    orderBy: { publishedAt: "desc" },
  });
});

export const getWinner = cache(async (slug: string, tenantSlug?: string) => {
  const tenant = await getTenant(tenantSlug);
  const winner = await db.winner.findUnique({
    where: { tenantId_slug: { tenantId: tenant.id, slug } },
    include: { campaign: true, prize: true },
  });
  if (!winner || winner.status !== "PUBLISHED") notFound();
  return winner;
});

export const getLegalDocument = cache(async (slug: string, tenantSlug?: string) => {
  const tenant = await getTenant(tenantSlug);
  if (slug === "official-rules") {
    const campaign = await getNavigationCampaign(tenantSlug);
    if (campaign) return assertCampaignOfficialRules(campaign);
  }
  const document = await db.legalDocument.findFirst({
    where: { tenantId: tenant.id, slug, status: "PUBLISHED" },
    orderBy: { version: "desc" },
  });
  if (!document) notFound();
  return document;
});

export const getLegalDocumentHistory = cache(async (slug: string, tenantSlug?: string) => {
  const tenant = await getTenant(tenantSlug);
  const documents = await db.legalDocument.findMany({
    where: { tenantId: tenant.id, slug, status: "PUBLISHED" },
    orderBy: { version: "desc" },
  });
  if (!documents.length) notFound();
  return documents;
});

export const getLegalDocumentVersion = cache(async (
  slug: string,
  version: number,
  tenantSlug?: string,
) => {
  if (!Number.isSafeInteger(version) || version < 1) notFound();
  const tenant = await getTenant(tenantSlug);
  const document = await db.legalDocument.findFirst({
    where: { tenantId: tenant.id, slug, version, status: "PUBLISHED" },
  });
  if (!document) notFound();
  return document;
});
