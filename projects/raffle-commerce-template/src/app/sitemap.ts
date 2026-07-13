import type { MetadataRoute } from "next";
import { getAllProducts, getHomeData, getPublishedWinners } from "@/server/storefront";
import { canonicalSiteUrl } from "@/server/site-url";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [{ tenant, campaign, collections }, products, winners] = await Promise.all([getHomeData(), getAllProducts(), getPublishedWinners()]);
  const siteUrl = canonicalSiteUrl(tenant);
  const staticPaths = ["", "/giveaways", "/shop", "/quick-entry", "/winners", "/help", "/how-it-works", "/membership", "/about", "/scam-awareness", "/policies", "/policies/official-rules", "/policies/privacy", "/policies/terms", "/policies/shipping-returns"];
  return [
    ...staticPaths.map((path, index) => ({ url: `${siteUrl}${path}`, changeFrequency: index === 0 ? "daily" as const : "monthly" as const, priority: index === 0 ? 1 : 0.7 })),
    { url: `${siteUrl}/giveaways/${campaign.slug}`, lastModified: campaign.updatedAt, changeFrequency: "daily" as const, priority: 0.95 },
    { url: `${siteUrl}/giveaways/${campaign.slug}/free-entry`, lastModified: campaign.updatedAt, changeFrequency: "daily" as const, priority: 0.9 },
    ...products.map((product) => ({ url: `${siteUrl}/products/${product.slug}`, lastModified: product.updatedAt, changeFrequency: "weekly" as const, priority: 0.8 })),
    ...collections.map((collection) => ({ url: `${siteUrl}/collections/${collection.slug}`, lastModified: collection.updatedAt, changeFrequency: "weekly" as const, priority: 0.75 })),
    ...winners.map((winner) => ({ url: `${siteUrl}/winners/${winner.slug}`, lastModified: winner.publishedAt ?? winner.updatedAt, changeFrequency: "yearly" as const, priority: 0.65 })),
  ];
}
