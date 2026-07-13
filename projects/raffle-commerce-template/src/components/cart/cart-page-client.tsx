"use client";

import Image from "next/image";
import Link from "next/link";
import { Minus, Plus, Trash2 } from "lucide-react";
import { useCart } from "./cart-provider";
import { formatEntries, formatMoney } from "@/lib/format";
import { calculateStorefrontEntryQuote, type StorefrontEntryQuote } from "@/lib/purchase-entry-rules";
import type { OfficialRulesHref } from "@/lib/official-rules";

export function CartPageClient({
  campaignSlug,
  brandName,
  purchaseEntryOpen,
  currency,
  entryQuotes,
  officialRulesHref,
}: {
  campaignSlug: string;
  brandName: string;
  purchaseEntryOpen: boolean;
  currency: string;
  entryQuotes: Record<string, StorefrontEntryQuote>;
  officialRulesHref: OfficialRulesHref;
}) {
  const { items, hydrated, subtotalCents, updateQuantity, removeItem } = useCart();
  const quotesComplete = items.every((item) => Boolean(entryQuotes[item.variantId]));
  const quotedSubtotalCents = quotesComplete ? items.reduce((total, item) => (
    total + entryQuotes[item.variantId]!.unitPriceCents * item.quantity
  ), 0) : subtotalCents;
  const estimatedEntries = quotesComplete ? items.reduce((total, item) => (
    total + calculateStorefrontEntryQuote(entryQuotes[item.variantId]!, item.quantity).finalEntries
  ), 0n) : null;

  if (!hydrated) return <div className="empty-state">Loading your cart…</div>;
  if (items.length === 0) {
    return (
      <div className="empty-state">
        <p className="eyebrow">YOUR CART</p>
        <h1>Nothing here yet.</h1>
        <p>Browse the latest gear or use the direct free-entry route—no purchase is required.</p>
        <div className="button-row">
          <Link className="button button-primary" href="/shop">Shop the collection</Link>
          <Link className="button button-secondary" href={`/giveaways/${campaignSlug}/free-entry`}>Free entry</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="cart-layout">
      <div className="cart-lines">
        {items.map((item, index) => (
          <article className="cart-line" key={`${item.productId}:${item.variantId}`}>
            <Link className="cart-line-image" href={`/products/${item.slug}`}>
              <Image
                src={item.image}
                alt=""
                fill
                loading={index === 0 ? "eager" : "lazy"}
                fetchPriority={index === 0 ? "high" : "auto"}
                sizes="140px"
              />
            </Link>
            <div className="cart-line-copy">
              <p className="eyebrow">{item.variantTitle === "Default" ? `${brandName} GEAR` : item.variantTitle}</p>
              <h2><Link href={`/products/${item.slug}`}>{item.title}</Link></h2>
              <p>{formatMoney(entryQuotes[item.variantId]?.unitPriceCents ?? item.priceCents, currency)} each</p>
              <p className="entry-copy">{entryQuotes[item.variantId]
                ? `${formatEntries(calculateStorefrontEntryQuote(entryQuotes[item.variantId]!, 1).finalEntries)} entries per item`
                : "Entry quote will be revalidated at checkout"}</p>
            </div>
            <div className="quantity-control" aria-label={`Quantity for ${item.title}`}>
              <button type="button" onClick={() => updateQuantity(item.productId, item.variantId, item.quantity - 1)} aria-label="Decrease quantity"><Minus size={15} /></button>
              <span aria-live="polite">{item.quantity}</span>
              <button type="button" onClick={() => updateQuantity(item.productId, item.variantId, item.quantity + 1)} aria-label="Increase quantity"><Plus size={15} /></button>
            </div>
            <div className="cart-line-total">
              <strong>{formatMoney((entryQuotes[item.variantId]?.unitPriceCents ?? item.priceCents) * item.quantity, currency)}</strong>
              <button className="text-button" type="button" onClick={() => removeItem(item.productId, item.variantId)}>
                <Trash2 aria-hidden="true" size={15} /> Remove
              </button>
            </div>
          </article>
        ))}
      </div>
      <aside className="cart-summary">
        <p className="eyebrow">ORDER SUMMARY</p>
        <dl>
          <div><dt>Subtotal</dt><dd>{formatMoney(quotedSubtotalCents, currency)}</dd></div>
          <div><dt>Estimated entries</dt><dd>{purchaseEntryOpen
            ? estimatedEntries == null ? "Revalidate cart" : formatEntries(estimatedEntries)
            : "Entry closed"}</dd></div>
          <div><dt>Shipping</dt><dd>Calculated next</dd></div>
        </dl>
        {purchaseEntryOpen ? (
          <Link className="button button-primary button-block" href="/checkout">Continue to checkout</Link>
        ) : (
          <p className="form-alert" role="status">This promotion’s purchase-entry period is not currently open, so promotional checkout is unavailable.</p>
        )}
        <p className="legal-short">NO PURCHASE NECESSARY. A PURCHASE WILL NOT INCREASE YOUR CHANCES OF WINNING. See <Link href={officialRulesHref}>Official Rules</Link> or <Link href={`/giveaways/${campaignSlug}/free-entry`}>enter free</Link>.</p>
      </aside>
    </div>
  );
}
