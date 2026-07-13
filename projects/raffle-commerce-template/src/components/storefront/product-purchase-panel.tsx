"use client";

import { useState } from "react";
import type { AddToCartProduct } from "@/components/cart/add-to-cart-button";
import { AddToCartButton } from "@/components/cart/add-to-cart-button";
import { calculateStorefrontEntryQuote, type StorefrontEntryQuote } from "@/lib/purchase-entry-rules";
import { formatEntries, formatMoney } from "@/lib/format";

export function ProductPurchasePanel({
  product,
  purchaseEntryOpen,
  entryQuotes,
  currency,
}: {
  product: AddToCartProduct;
  purchaseEntryOpen: boolean;
  entryQuotes: Record<string, StorefrontEntryQuote>;
  currency: string;
}) {
  const [variantId, setVariantId] = useState(product.variants[0]?.id ?? "");
  const selected = product.variants.find((variant) => variant.id === variantId) ?? product.variants[0];
  const selectedPriceCents = selected?.priceCents ?? product.priceCents;
  const selectedQuote = selected ? entryQuotes[selected.id] : undefined;
  if (purchaseEntryOpen && selected && !selectedQuote) throw new Error("Product option is missing its published entry quote");
  const selectedEntries = selectedQuote ? calculateStorefrontEntryQuote(selectedQuote, 1).finalEntries : 0n;

  return (
    <div className="purchase-panel">
      {product.variants.length > 1 ? (
        <label className="field-label" htmlFor="variant">
          <span>Choose an option</span>
          <select id="variant" value={variantId} onChange={(event) => setVariantId(event.target.value)}>
            {product.variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.title}</option>)}
          </select>
        </label>
      ) : null}
      {selected ? (
        <p className="purchase-variant-quote" aria-live="polite">
          <strong>{formatMoney(selectedPriceCents, currency)}</strong>
          <span>{purchaseEntryOpen ? `${formatEntries(selectedEntries)} entries for this option` : "Promotional entry is unavailable"}</span>
        </p>
      ) : null}
      {purchaseEntryOpen ? (
        <AddToCartButton product={product} variantId={variantId} className="button button-primary button-large" />
      ) : (
        <p className="form-alert" role="status">This promotion’s purchase-entry checkout is closed.</p>
      )}
      <p>{purchaseEntryOpen ? "Secure checkout · Entry total shown before payment · Returns follow the published policy" : "Browse the product details while winner verification proceeds."}</p>
    </div>
  );
}
