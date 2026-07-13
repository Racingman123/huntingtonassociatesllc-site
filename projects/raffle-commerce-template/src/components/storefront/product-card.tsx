import Image from "next/image";
import Link from "next/link";
import type { Product, ProductVariant } from "@prisma/client";
import { AddToCartButton } from "@/components/cart/add-to-cart-button";
import { calculateStorefrontEntryQuote } from "@/lib/purchase-entry-rules";
import { formatEntries, formatMoney } from "@/lib/format";
import type { StorefrontEntryQuoteLookup } from "@/server/commerce/storefront-quotes";

export type StoreProduct = Product & { variants: ProductVariant[] };

export function ProductCard({
  product,
  entryQuotes,
  showQuickAdd = true,
  entriesAvailable,
  currency,
}: {
  product: StoreProduct;
  entryQuotes: StorefrontEntryQuoteLookup;
  showQuickAdd?: boolean;
  entriesAvailable: boolean;
  currency: string;
}) {
  const displayVariant = product.variants.reduce((lowest, variant) => (
    !lowest || (variant.priceCents ?? product.priceCents) < (lowest.priceCents ?? product.priceCents)
      ? variant
      : lowest
  ), product.variants[0]);
  const displayPriceCents = displayVariant?.priceCents ?? product.priceCents;
  const hasPriceRange = product.variants.some(
    (variant) => (variant.priceCents ?? product.priceCents) !== displayPriceCents,
  );
  const serverQuote = displayVariant ? entryQuotes[displayVariant.id] : undefined;
  if (entriesAvailable && !serverQuote) throw new Error("Product option is missing its published entry quote");
  const entryQuote = serverQuote ? calculateStorefrontEntryQuote(serverQuote, 1) : null;
  const canQuickAdd = showQuickAdd && product.variants.length === 1;

  return (
    <article className="product-card">
      <Link className="product-card-media" href={`/products/${product.slug}`} aria-label={`View ${product.title}`}>
        <Image
          src={product.image}
          alt=""
          fill
          sizes="(max-width: 640px) 72vw, (max-width: 1100px) 42vw, 24vw"
        />
        {product.badge ? <span className="product-badge">{product.badge}</span> : null}
        {product.secondaryImage ? (
          <Image className="product-card-secondary" src={product.secondaryImage} alt="" fill sizes="25vw" />
        ) : null}
      </Link>
      <div className="product-card-body">
        <p className="product-category">{product.category}</p>
        <h3><Link href={`/products/${product.slug}`}>{product.title}</Link></h3>
        {product.subtitle ? <p className="product-subtitle">{product.subtitle}</p> : null}
        <div className="product-card-price">
          <strong>{hasPriceRange ? "From " : ""}{formatMoney(displayPriceCents, currency)}</strong>
          {product.compareAtCents ? <s>{formatMoney(product.compareAtCents, currency)}</s> : null}
        </div>
        <p className="entry-quote">
          <strong>{entriesAvailable && entryQuote ? `${formatEntries(entryQuote.finalEntries)} entries` : "Entry unavailable"}</strong>
          <span>{entriesAvailable && serverQuote ? `${serverQuote.effectiveMultiplier}X effective rate` : "No promotional checkout"}</span>
        </p>
        {canQuickAdd && entriesAvailable ? (
          <AddToCartButton product={product} className="button button-primary product-card-button" />
        ) : (
          <Link className="button button-secondary product-card-button" href={`/products/${product.slug}`}>
            {entriesAvailable ? "Choose options" : "View product"}
          </Link>
        )}
      </div>
    </article>
  );
}
