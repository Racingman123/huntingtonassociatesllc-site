import type { Metadata } from "next";
import { CartPageClient } from "@/components/cart/cart-page-client";
import { getActiveCampaign, getAllProducts, getPublishedTheme, getTenant } from "@/server/storefront";
import { campaignAvailability } from "@/server/campaigns/availability";
import { createStorefrontEntryQuoteLookup } from "@/server/commerce/storefront-quotes";
import { assertCampaignOfficialRules, officialRulesHref } from "@/lib/official-rules";

export const metadata: Metadata = { title: "Cart" };

export default async function CartPage() {
  const [campaign, products, theme, tenant] = await Promise.all([getActiveCampaign(), getAllProducts(), getPublishedTheme(), getTenant()]);
  const availability = campaignAvailability(campaign);
  const entryQuotes = availability.purchaseEntryOpen
    ? createStorefrontEntryQuoteLookup(campaign, products)
    : {};
  return (
    <main className="page-shell cart-page">
      <header className="page-heading">
        <p className="eyebrow">YOUR ORDER</p>
        <h1>Cart</h1>
      </header>
      <CartPageClient
        campaignSlug={campaign.slug}
        brandName={theme.brand.shortName}
        purchaseEntryOpen={availability.purchaseEntryOpen}
        currency={tenant.currency}
        entryQuotes={entryQuotes}
        officialRulesHref={officialRulesHref(assertCampaignOfficialRules(campaign))}
      />
    </main>
  );
}
