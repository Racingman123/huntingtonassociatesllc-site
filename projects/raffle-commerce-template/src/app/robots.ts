import type { MetadataRoute } from "next";
import { getTenant } from "@/server/storefront";
import { canonicalSiteUrl } from "@/server/site-url";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const siteUrl = canonicalSiteUrl(await getTenant());
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/admin/", "/account/", "/api/", "/checkout/"] },
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
