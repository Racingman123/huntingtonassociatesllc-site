import type { Metadata } from "next";
import { CheckoutForm } from "@/components/checkout/checkout-form";
import { getActiveCampaign, getAllProducts, getTenant } from "@/server/storefront";
import Link from "next/link";
import { campaignAvailability } from "@/server/campaigns/availability";
import { campaignEligibilityOptions } from "@/server/campaigns/eligibility";
import { createStorefrontEntryQuoteLookup } from "@/server/commerce/storefront-quotes";
import { assertCampaignOfficialRules, officialRulesHref } from "@/lib/official-rules";

export const metadata: Metadata = { title: "Checkout", robots: { index: false, follow: false } };

export default async function CheckoutPage() {
  const [campaign, products, tenant] = await Promise.all([getActiveCampaign(), getAllProducts(), getTenant()]);
  const availability = campaignAvailability(campaign);
  const eligibility = campaignEligibilityOptions(campaign);
  if (!availability.purchaseEntryOpen) {
    return (
      <main className="page-shell checkout-page">
        <div className="empty-state">
          <h1>{availability.publicState === "UPCOMING" ? "Promotional checkout is not open yet." : "Promotional checkout is closed."}</h1>
          <p>{availability.publicState === "UPCOMING" ? "The purchase-entry period has not started. No order or entry was created." : "The purchase-entry deadline has passed. No order or entry was created."}</p>
          <div className="button-row">
            {availability.freeEntryOpen ? (
              <Link className="button button-primary" href={`/giveaways/${campaign.slug}/free-entry`}>Enter without purchase</Link>
            ) : null}
            <Link className="button button-secondary" href={`/giveaways/${campaign.slug}`}>Promotion details</Link>
          </div>
        </div>
      </main>
    );
  }
  const entryQuotes = createStorefrontEntryQuoteLookup(campaign, products);
  return (
    <main className="page-shell checkout-page">
      <CheckoutForm
        campaignSlug={campaign.slug}
        demoMode={process.env.DEMO_MODE === "true"}
        minimumAge={campaign.minimumAge}
        eligibleCountries={eligibility.countries}
        currency={tenant.currency}
        flatShippingCents={tenant.flatShippingCents}
        freeShippingThresholdCents={tenant.freeShippingThresholdCents}
        entryQuotes={entryQuotes}
        officialRulesHref={officialRulesHref(assertCampaignOfficialRules(campaign))}
      />
    </main>
  );
}
