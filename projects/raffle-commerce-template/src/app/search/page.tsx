import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Search } from "lucide-react";
import { Container } from "@/components/ui/container";
import { ProductGrid } from "@/components/storefront/product-grid";
import { getActiveCampaign, getAllProducts, getPublishedTheme, getTenant } from "@/server/storefront";
import { campaignAvailability } from "@/server/campaigns/availability";
import { createStorefrontEntryQuoteLookup } from "@/server/commerce/storefront-quotes";

export const metadata: Metadata = {
  title: "Search",
  description: "Search products, categories, and available gear.",
  robots: { index: false, follow: true },
};

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const [{ q }, products, campaign, theme, tenant] = await Promise.all([searchParams, getAllProducts(), getActiveCampaign(), getPublishedTheme(), getTenant()]);
  const query = typeof q === "string" ? q.trim() : "";
  const normalized = query.toLocaleLowerCase();
  const results = normalized
    ? products.filter((product) => [product.title, product.subtitle ?? "", product.description, product.category, product.tagsJson].some((value) => value.toLocaleLowerCase().includes(normalized)))
    : products.filter((product) => product.featured).slice(0, 6);
  const availability = campaignAvailability(campaign);
  const entryQuotes = availability.purchaseEntryOpen
    ? createStorefrontEntryQuoteLookup(campaign, results)
    : {};

  return (
    <main className="public-page">
      <section className="search-header">
        <Container>
          <Link className="back-link" href="/shop"><ArrowLeft aria-hidden="true" size={16} /> Back to shop</Link>
          <p className="eyebrow">Find your gear</p><h1>Search {theme.brand.shortName}</h1>
          <form action="/search" method="get" role="search"><label className="sr-only" htmlFor="site-search">Search products</label><Search aria-hidden="true" /><input id="site-search" name="q" type="search" defaultValue={query} placeholder="Try “roadside,” “wallet,” or “tee”" autoFocus /><button className="button button-accent" type="submit">Search</button></form>
        </Container>
      </section>
      <section className="section search-results"><Container><header><h2>{query ? `${results.length} result${results.length === 1 ? "" : "s"} for “${query}”` : "Popular right now"}</h2>{query ? <Link href="/search">Clear search</Link> : null}</header>{results.length ? <ProductGrid products={results} entryQuotes={entryQuotes} entriesAvailable={availability.purchaseEntryOpen} currency={tenant.currency} /> : <div className="empty-state"><Search aria-hidden="true" /><h2>No gear matched that search.</h2><p>Check the spelling, try a broader category, or browse the full collection.</p><Link className="button button-primary" href="/shop">Browse all products</Link></div>}</Container></section>
    </main>
  );
}
