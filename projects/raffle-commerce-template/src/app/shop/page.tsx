import type { Metadata } from "next";
import Link from "next/link";
import { SlidersHorizontal } from "lucide-react";
import { Container } from "@/components/ui/container";
import { Disclosure } from "@/components/storefront/disclosure";
import { PageHero } from "@/components/storefront/page-hero";
import { ProductGrid } from "@/components/storefront/product-grid";
import { getActiveCampaign, getAllProducts, getPublishedTheme, getTenant } from "@/server/storefront";
import { campaignAvailability } from "@/server/campaigns/availability";
import { assertCampaignOfficialRules, officialRulesHref } from "@/lib/official-rules";
import { createStorefrontEntryQuoteLookup } from "@/server/commerce/storefront-quotes";

export const metadata: Metadata = {
  title: "Shop All Gear",
  description: "Explore apparel, gear, accessories, and digital supporter packs.",
  alternates: { canonical: "/shop" },
};

type ShopSearchParams = Promise<{ category?: string | string[]; sort?: string | string[] }>;

export default async function ShopPage({ searchParams }: { searchParams: ShopSearchParams }) {
  const [{ category, sort }, products, campaign, theme, tenant] = await Promise.all([searchParams, getAllProducts(), getActiveCampaign(), getPublishedTheme(), getTenant()]);
  const requestedCategory = typeof category === "string" ? category : "all";
  const requestedSort = typeof sort === "string" ? sort : "featured";
  const categories = Array.from(new Set(products.map((product) => product.category))).sort();
  const visible = requestedCategory === "all" ? [...products] : products.filter((product) => product.category === requestedCategory);
  if (requestedSort === "price-asc") visible.sort((a, b) => a.priceCents - b.priceCents);
  if (requestedSort === "price-desc") visible.sort((a, b) => b.priceCents - a.priceCents);
  if (requestedSort === "title") visible.sort((a, b) => a.title.localeCompare(b.title));
  const availability = campaignAvailability(campaign);
  const rulesHref = officialRulesHref(assertCampaignOfficialRules(campaign));
  const entryQuotes = availability.purchaseEntryOpen
    ? createStorefrontEntryQuoteLookup(campaign, visible)
    : {};
  const effectiveRates = Object.values(entryQuotes).map((quote) => quote.effectiveMultiplier);

  return (
    <main className="public-page">
      <PageHero eyebrow={`The ${theme.brand.shortName} store`} title="Useful gear. Wild possibilities." description="Every product stands on its own. During a live promotion, qualifying purchases also receive the exact entry total shown before checkout." tone="light">
        <div className="shop-rate"><small>{availability.purchaseEntryOpen ? "Published effective rates" : "Promotion status"}</small><strong>{availability.purchaseEntryOpen && effectiveRates.length ? `${Math.min(...effectiveRates)}X–${Math.max(...effectiveRates)}X` : availability.publicState === "UPCOMING" ? "Soon" : "Closed"}</strong><span>{availability.purchaseEntryOpen ? "exact quote shown on every option" : availability.publicState === "UPCOMING" ? "entry has not opened" : "promotional checkout unavailable"}</span></div>
      </PageHero>
      <Disclosure text={campaign.noPurchaseDisclosure} campaignSlug={campaign.slug} officialRulesHref={rulesHref} compact />
      <section className="section shop-section">
        <Container>
          <div className="shop-toolbar">
            <div className="category-pills" aria-label="Product categories">
              <Link className={requestedCategory === "all" ? "active" : ""} href="/shop">All</Link>
              {categories.map((item) => (
                <Link className={requestedCategory === item ? "active" : ""} key={item} href={`/shop?category=${encodeURIComponent(item)}`}>{item}</Link>
              ))}
            </div>
            <details className="sort-menu">
              <summary><SlidersHorizontal aria-hidden="true" size={17} /> Sort</summary>
              <div>
                <Link href={`/shop?category=${encodeURIComponent(requestedCategory)}&sort=featured`}>Featured</Link>
                <Link href={`/shop?category=${encodeURIComponent(requestedCategory)}&sort=price-asc`}>Price: low to high</Link>
                <Link href={`/shop?category=${encodeURIComponent(requestedCategory)}&sort=price-desc`}>Price: high to low</Link>
                <Link href={`/shop?category=${encodeURIComponent(requestedCategory)}&sort=title`}>Alphabetical</Link>
              </div>
            </details>
          </div>
          <p className="results-count">Showing {visible.length} {visible.length === 1 ? "product" : "products"}</p>
          <ProductGrid products={visible} entryQuotes={entryQuotes} entriesAvailable={availability.purchaseEntryOpen} currency={tenant.currency} />
        </Container>
      </section>
    </main>
  );
}
