import { getActiveCampaign, getAllProducts, getTenant } from "@/server/storefront";
import { campaignAvailability } from "@/server/campaigns/availability";
import { createStorefrontEntryQuoteLookup } from "@/server/commerce/storefront-quotes";

export async function GET() {
  const [campaign, products, tenant] = await Promise.all([
    getActiveCampaign(),
    getAllProducts(),
    getTenant(),
  ]);
  const availability = campaignAvailability(campaign);
  const entryQuotes = availability.purchaseEntryOpen
    ? createStorefrontEntryQuoteLookup(campaign, products)
    : {};
  return Response.json({
    promotion: {
      slug: campaign.slug,
      status: availability.publicState,
      purchaseEntryOpen: availability.purchaseEntryOpen,
    },
    data: products.map((product) => ({
      id: product.id,
      slug: product.slug,
      title: product.title,
      subtitle: product.subtitle,
      description: product.description,
      type: product.productType,
      category: product.category,
      priceCents: product.priceCents,
      compareAtCents: product.compareAtCents,
      currency: tenant.currency,
      image: product.image,
      secondaryImage: product.secondaryImage,
      badge: product.badge,
      variants: product.variants.map((variant) => ({
        id: variant.id,
        title: variant.title,
        priceCents: variant.priceCents ?? product.priceCents,
        available: variant.inventory > 0,
        entryMultiplier: entryQuotes[variant.id]?.effectiveMultiplier ?? null,
        entryRuleIds: entryQuotes[variant.id]?.ruleSnapshot.matchedRules.map((rule) => rule.id) ?? [],
      })),
    })),
  }, { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } });
}
