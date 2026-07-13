import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Container } from "@/components/ui/container";
import { Disclosure } from "@/components/storefront/disclosure";
import { ProductGrid } from "@/components/storefront/product-grid";
import { getActiveCampaign, getCollection, getPublishedTheme, getTenant } from "@/server/storefront";
import { campaignAvailability } from "@/server/campaigns/availability";
import { assertCampaignOfficialRules, officialRulesHref } from "@/lib/official-rules";
import { createStorefrontEntryQuoteLookup } from "@/server/commerce/storefront-quotes";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const collection = await getCollection(slug);
  return {
    title: collection.title,
    description: collection.description,
    alternates: { canonical: `/collections/${collection.slug}` },
  };
}

export default async function CollectionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [collection, campaign, theme, tenant] = await Promise.all([getCollection(slug), getActiveCampaign(), getPublishedTheme(), getTenant()]);
  const products = collection.products.map((item) => item.product).filter((product) => product.status === "ACTIVE");
  const availability = campaignAvailability(campaign);
  const rulesHref = officialRulesHref(assertCampaignOfficialRules(campaign));
  const entryQuotes = availability.purchaseEntryOpen
    ? createStorefrontEntryQuoteLookup(campaign, products)
    : {};

  return (
    <main className="public-page">
      <section className="collection-hero">
        {collection.image ? <Image src={collection.image} alt="" fill loading="eager" sizes="100vw" /> : null}
        <span className="collection-hero-shade" />
        <Container>
          <Link className="back-link" href="/shop"><ArrowLeft aria-hidden="true" size={16} /> All products</Link>
          <p className="eyebrow">{theme.brand.shortName} collections</p>
          <h1>{collection.title}</h1>
          <p>{collection.description}</p>
          <strong>{products.length} {products.length === 1 ? "product" : "products"}</strong>
        </Container>
      </section>
      <Disclosure text={campaign.noPurchaseDisclosure} campaignSlug={campaign.slug} officialRulesHref={rulesHref} compact />
      <section className="section">
        <Container>
          {products.length ? (
            <ProductGrid products={products} entryQuotes={entryQuotes} entriesAvailable={availability.purchaseEntryOpen} currency={tenant.currency} />
          ) : (
            <div className="empty-state"><h2>Nothing here right now.</h2><p>This collection is between drops. The full shop still has plenty to explore.</p><Link className="button button-primary" href="/shop">Browse the shop</Link></div>
          )}
        </Container>
      </section>
    </main>
  );
}
