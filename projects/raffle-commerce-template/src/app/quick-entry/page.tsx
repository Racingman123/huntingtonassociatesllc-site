import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, Clock3, Download, ShieldCheck, Sparkles } from "lucide-react";
import { Container } from "@/components/ui/container";
import { Disclosure } from "@/components/storefront/disclosure";
import { ProductGrid } from "@/components/storefront/product-grid";
import { SectionHeading } from "@/components/storefront/section-heading";
import { getActiveCampaign, getAllProducts, getPublishedTheme, getTenant } from "@/server/storefront";
import { campaignAvailability } from "@/server/campaigns/availability";
import { assertCampaignOfficialRules, officialRulesHref } from "@/lib/official-rules";
import { createStorefrontEntryQuoteLookup } from "@/server/commerce/storefront-quotes";

export const metadata: Metadata = {
  title: "Quick Entry Digital Packs",
  description: "Explore digital supporter packs with instant delivery and clearly quoted promotional entries. No purchase necessary.",
  alternates: { canonical: "/quick-entry" },
};

export default async function QuickEntryPage() {
  const [products, campaign, theme, tenant] = await Promise.all([getAllProducts(), getActiveCampaign(), getPublishedTheme(), getTenant()]);
  const quickEntryProducts = products.filter((product) => product.category === "Quick Entry");
  const availability = campaignAvailability(campaign);
  const rulesHref = officialRulesHref(assertCampaignOfficialRules(campaign));
  const entryQuotes = availability.purchaseEntryOpen
    ? createStorefrontEntryQuoteLookup(campaign, quickEntryProducts)
    : {};
  const effectiveRates = Object.values(entryQuotes).map((quote) => quote.effectiveMultiplier);
  return (
    <main className="public-page">
      <section className="quick-entry-hero">
        <Container>
          <div><p className="eyebrow"><Clock3 aria-hidden="true" /> Browse less. Keep moving.</p><h1>Quick Entry</h1><p>Instant digital supporter packs for the people who do not need another shirt. Every pack includes original {theme.brand.shortName} art and earns the exact promotional entry quote shown while entry is open.</p><div className="button-row"><a className="button button-accent" href="#quick-entry-packs">See the packs</a>{availability.freeEntryOpen ? <Link className="button button-glass" href={`/giveaways/${campaign.slug}/free-entry`}>Enter without purchase</Link> : null}</div></div>
          <div className="quick-rate"><Sparkles aria-hidden="true" /><small>{availability.purchaseEntryOpen ? "Published quick-entry rates" : "Promotion status"}</small><strong>{availability.purchaseEntryOpen && effectiveRates.length ? `${Math.min(...effectiveRates)}X–${Math.max(...effectiveRates)}X` : availability.publicState === "UPCOMING" ? "Soon" : "Closed"}</strong><span>{availability.purchaseEntryOpen ? "campaign × catalog × published rules" : availability.publicState === "UPCOMING" ? "entry has not opened" : "promotional checkout unavailable"}</span></div>
        </Container>
      </section>
      <Disclosure text={campaign.noPurchaseDisclosure} campaignSlug={campaign.slug} officialRulesHref={rulesHref} />
      <section id="quick-entry-packs" className="section section-surface">
        <Container><SectionHeading eyebrow="Pick your pack" title="Same art. Different bundle sizes." description="Your digital product is delivered after successful checkout and remains yours regardless of the drawing outcome." /><ProductGrid products={quickEntryProducts} entryQuotes={entryQuotes} entriesAvailable={availability.purchaseEntryOpen} currency={tenant.currency} /></Container>
      </section>
      <section className="section quick-benefits"><Container><article><Download aria-hidden="true" /><h2>Digital fulfillment</h2><p>A live deployment delivers purchased files after confirmed payment through its configured provider; the local demo records intent only.</p></article><article><CheckCircle2 aria-hidden="true" /><h2>Exact quote</h2><p>The product page, cart, and checkout show the same calculation before your entries post.</p></article><article><ShieldCheck aria-hidden="true" /><h2>Optional path</h2><p>Quick Entry is never required. The free online method joins the same drawing and can reach the same entry cap.</p></article></Container></section>
    </main>
  );
}
