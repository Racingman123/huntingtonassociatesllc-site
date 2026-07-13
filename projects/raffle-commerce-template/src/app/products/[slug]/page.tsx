import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, PackageCheck, RotateCcw, ShieldCheck, Sparkles, Truck } from "lucide-react";
import { Container } from "@/components/ui/container";
import { Disclosure } from "@/components/storefront/disclosure";
import { ProductGrid } from "@/components/storefront/product-grid";
import { ProductPurchasePanel } from "@/components/storefront/product-purchase-panel";
import { SectionHeading } from "@/components/storefront/section-heading";
import { formatEntries, formatMoney } from "@/lib/format";
import { calculateStorefrontEntryQuote } from "@/lib/purchase-entry-rules";
import { assertCampaignOfficialRules, officialRulesHref } from "@/lib/official-rules";
import { getActiveCampaign, getAllProducts, getProduct, getTenant } from "@/server/storefront";
import { campaignAvailability } from "@/server/campaigns/availability";
import { createStorefrontEntryQuoteLookup } from "@/server/commerce/storefront-quotes";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProduct(slug);
  return {
    title: product.title,
    description: product.description,
    alternates: { canonical: `/products/${product.slug}` },
  };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [product, campaign, allProducts, tenant] = await Promise.all([getProduct(slug), getActiveCampaign(), getAllProducts(), getTenant()]);
  const displayPriceCents = product.variants.length
    ? Math.min(...product.variants.map((variant) => variant.priceCents ?? product.priceCents))
    : product.priceCents;
  const hasPriceRange = product.variants.some(
    (variant) => (variant.priceCents ?? product.priceCents) !== displayPriceCents,
  );
  const related = allProducts.filter((item) => item.id !== product.id && item.category === product.category).slice(0, 4);
  const fallbackRelated = related.length >= 2 ? related : allProducts.filter((item) => item.id !== product.id).slice(0, 4);
  const availability = campaignAvailability(campaign);
  const rulesHref = officialRulesHref(assertCampaignOfficialRules(campaign));
  const entryQuotes = availability.purchaseEntryOpen
    ? createStorefrontEntryQuoteLookup(campaign, [product, ...fallbackRelated])
    : {};
  const displayVariant = product.variants.find((variant) => (
    (variant.priceCents ?? product.priceCents) === displayPriceCents
  ));
  const displayQuote = displayVariant ? entryQuotes[displayVariant.id] : undefined;
  if (availability.purchaseEntryOpen && !displayQuote) throw new Error("Product option is missing its published entry quote");
  const entryQuote = displayQuote ? calculateStorefrontEntryQuote(displayQuote, 1) : null;
  const productJsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    description: product.description,
    image: product.image,
    sku: product.variants[0]?.sku,
    offers: {
      "@type": "Offer",
      priceCurrency: tenant.currency,
      price: (displayPriceCents / 100).toFixed(2),
      availability: product.variants.some((variant) => variant.inventory - variant.reservedInventory > 0)
        ? "https://schema.org/InStock"
        : "https://schema.org/OutOfStock",
    },
  };

  return (
    <main className="public-page">
      <Container className="breadcrumb-row"><Link href="/shop"><ArrowLeft aria-hidden="true" size={16} /> Back to shop</Link><span>/</span><span>{product.category}</span></Container>
      <section className="product-detail section">
        <Container className="product-detail-grid">
          <div className="product-gallery">
            <div className="product-main-image"><Image src={product.image} alt={product.title} fill loading="eager" fetchPriority="high" sizes="(max-width: 900px) 100vw, 56vw" /></div>
            {product.secondaryImage ? <div className="product-secondary-image"><Image src={product.secondaryImage} alt={`${product.title}, alternate view`} fill sizes="(max-width: 900px) 100vw, 56vw" /></div> : null}
          </div>
          <div className="product-detail-copy">
            <p className="product-category">{product.category}</p>
            {product.badge ? <span className="detail-badge">{product.badge}</span> : null}
            <h1>{product.title}</h1>
            {product.subtitle ? <p className="product-detail-subtitle">{product.subtitle}</p> : null}
            <div className="product-detail-price"><strong>{hasPriceRange ? "From " : ""}{formatMoney(displayPriceCents, tenant.currency)}</strong>{product.compareAtCents ? <s>{formatMoney(product.compareAtCents, tenant.currency)}</s> : null}</div>
            <div className="detail-entry-quote">
              <Sparkles aria-hidden="true" />
              <div><small>{availability.purchaseEntryOpen ? "Your current entry quote" : "Promotion status"}</small><strong>{availability.purchaseEntryOpen && entryQuote ? `${formatEntries(entryQuote.finalEntries)} entries` : "Entry period closed"}</strong><span>{availability.purchaseEntryOpen && displayQuote ? `${displayQuote.effectiveMultiplier}X effective rate on one item` : "Promotional checkout is unavailable"}</span></div>
            </div>
            <p className="product-description">{product.description}</p>
            <ProductPurchasePanel
              product={product}
              purchaseEntryOpen={availability.purchaseEntryOpen}
              entryQuotes={entryQuotes}
              currency={tenant.currency}
            />
            <Disclosure text={campaign.noPurchaseDisclosure} campaignSlug={campaign.slug} officialRulesHref={rulesHref} compact />
            <ul className="product-assurances">
              <li><PackageCheck aria-hidden="true" /><span><strong>Real product</strong> Yours to keep regardless of outcome.</span></li>
              <li><Truck aria-hidden="true" /><span><strong>Clear fulfillment record</strong> Confirmation records digital or physical fulfillment intent; live delivery and tracking require the configured provider.</span></li>
              <li><RotateCcw aria-hidden="true" /><span><strong>Published return policy</strong> Eligible settled refunds use the original entry quote for any rules-based reversal.</span></li>
              <li><ShieldCheck aria-hidden="true" /><span><strong>Auditable entries</strong> Payment confirmation posts entries to the campaign ledger.</span></li>
            </ul>
          </div>
        </Container>
      </section>
      {availability.purchaseEntryOpen ? (
        <section className="entry-explainer-band">
          <Container>
            <div><small>Qualifying price</small><strong>{formatMoney(entryQuote!.qualifyingCents, tenant.currency)}</strong></div>
            <span>×</span><div><small>Base rate</small><strong>{campaign.baseEntriesPerDollar}/whole unit</strong></div>
            <span>×</span><div><small>Published effective multiplier</small><strong>{displayQuote!.effectiveMultiplier}X</strong></div>
            <span>=</span><div className="entry-explainer-total"><small>Entry quote</small><strong>{formatEntries(entryQuote!.finalEntries)}</strong></div>
          </Container>
        </section>
      ) : null}
      {fallbackRelated.length ? (
        <section className="section">
          <Container>
            <SectionHeading eyebrow="Keep exploring" title="You might also like." href="/shop" linkLabel="Shop everything" />
            <ProductGrid products={fallbackRelated} entryQuotes={entryQuotes} entriesAvailable={availability.purchaseEntryOpen} currency={tenant.currency} />
          </Container>
        </section>
      ) : null}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd).replaceAll("<", "\\u003c") }} />
    </main>
  );
}
