"use client";

import { useActionState, useMemo } from "react";
import Link from "next/link";
import { LockKeyhole } from "lucide-react";
import { submitCheckout, type CheckoutState } from "@/app/checkout/actions";
import { useCart } from "@/components/cart/cart-provider";
import { formatEntries, formatMoney } from "@/lib/format";
import { calculateStorefrontEntryQuote, type StorefrontEntryQuote } from "@/lib/purchase-entry-rules";
import type { OfficialRulesHref } from "@/lib/official-rules";

const initialState: CheckoutState = {};

function FieldError({ errors }: { errors?: string[] }) {
  if (!errors?.length) return null;
  return <p className="field-error">{errors[0]}</p>;
}

export function CheckoutForm({
  campaignSlug,
  demoMode,
  minimumAge,
  eligibleCountries,
  currency,
  flatShippingCents,
  freeShippingThresholdCents,
  entryQuotes,
  officialRulesHref,
}: {
  campaignSlug: string;
  demoMode: boolean;
  minimumAge: number;
  eligibleCountries: string[];
  currency: string;
  flatShippingCents: number;
  freeShippingThresholdCents: number;
  entryQuotes: Record<string, StorefrontEntryQuote>;
  officialRulesHref: OfficialRulesHref;
}) {
  const { items, hydrated, subtotalCents } = useCart();
  const [state, action, pending] = useActionState(submitCheckout, initialState);
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
  const physicalItems = items.some((item) => item.productType === "PHYSICAL");
  const quotesComplete = items.every((item) => Boolean(entryQuotes[item.variantId]));
  const quotedSubtotalCents = quotesComplete ? items.reduce((total, item) => (
    total + entryQuotes[item.variantId]!.unitPriceCents * item.quantity
  ), 0) : subtotalCents;
  const quotedShippingCents = physicalItems && quotedSubtotalCents < freeShippingThresholdCents
    ? flatShippingCents
    : 0;
  const estimatedEntries = quotesComplete ? items.reduce((sum, item) => (
    sum + calculateStorefrontEntryQuote(entryQuotes[item.variantId]!, item.quantity).finalEntries
  ), 0n) : null;
  const cartPayload = JSON.stringify(items.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })));

  if (!hydrated) return <div className="empty-state">Preparing secure checkout…</div>;
  if (!items.length) {
    return (
      <div className="empty-state">
        <h1>Your cart is empty.</h1>
        <p>Add an item before checking out, or use the free alternative method of entry.</p>
        <div className="button-row">
          <Link className="button button-primary" href="/shop">Shop</Link>
          <Link className="button button-secondary" href={`/giveaways/${campaignSlug}/free-entry`}>Enter free</Link>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="checkout-layout">
      <input type="hidden" name="cart" value={cartPayload} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <section className="checkout-form-card" aria-labelledby="checkout-contact-heading">
        <p className="eyebrow">{demoMode ? "DEMO CHECKOUT" : "SECURE CHECKOUT"}</p>
        <h1 id="checkout-contact-heading">Contact and delivery</h1>
        <p className="form-note">{demoMode
          ? "Demo mode records a test order and entries without collecting or transmitting card details."
          : "Your order is prepared from server-verified prices, then payment is collected on Stripe’s hosted checkout. Entries post only after Stripe confirms payment."}</p>
        {state.message && <div className="form-alert" role="alert">{state.message}</div>}
        <div className="form-grid">
          <label className="field field-full">
            <span>Email</span>
            <input name="email" type="email" autoComplete="email" required aria-describedby="email-error" />
            <span id="email-error"><FieldError errors={state.errors?.email} /></span>
          </label>
          <label className="field field-full">
            <span>Full name</span>
            <input name="name" autoComplete="name" required />
            <FieldError errors={state.errors?.name} />
          </label>
          <label className="field field-full">
            <span>Phone</span>
            <input name="phone" type="tel" autoComplete="tel" inputMode="tel" required />
            <FieldError errors={state.errors?.phone} />
          </label>
          <label className="field field-full">
            <span>Street address</span>
            <input name="address1" autoComplete="address-line1" required />
            <FieldError errors={state.errors?.address1} />
          </label>
          <label className="field field-full">
            <span>Apartment, suite, etc. <small>Optional</small></span>
            <input name="address2" autoComplete="address-line2" />
          </label>
          <label className="field">
            <span>City</span>
            <input name="city" autoComplete="address-level2" required />
            <FieldError errors={state.errors?.city} />
          </label>
          <label className="field">
            <span>Country</span>
            <select name="country" defaultValue={eligibleCountries[0]} required>
              {eligibleCountries.map((country) => <option key={country} value={country}>{country}</option>)}
            </select>
            <FieldError errors={state.errors?.country} />
          </label>
          <label className="field">
            <span>State / province / region</span>
            <input name="region" autoComplete="address-level1" required maxLength={40} />
            <FieldError errors={state.errors?.region} />
          </label>
          <label className="field">
            <span>Postal code</span>
            <input name="postalCode" autoComplete="postal-code" required />
            <FieldError errors={state.errors?.postalCode} />
          </label>
        </div>
        <fieldset className="consent-group">
          <legend>Required confirmations</legend>
          <label className="check-row">
            <input name="ageConfirmed" type="checkbox" required />
            <span>I confirm that I am at least {minimumAge} and the age of majority where I live, and that the eligibility summary applies to me.</span>
          </label>
          <label className="check-row">
            <input name="rulesAccepted" type="checkbox" required />
            <span>I have read and accept the <Link href={officialRulesHref} target="_blank">Official Rules</Link>. I understand a purchase is not required.</span>
          </label>
        </fieldset>
        <fieldset className="consent-group optional-consent">
          <legend>Optional marketing</legend>
          <label className="check-row">
            <input name="marketingConsent" type="checkbox" />
            <span>Send me product news and future promotion updates. This is optional and does not affect entry or odds.</span>
          </label>
        </fieldset>
      </section>

      <aside className="checkout-summary">
        <p className="eyebrow">ORDER SUMMARY</p>
        <ul className="checkout-items">
          {items.map((item) => (
            <li key={`${item.productId}:${item.variantId}`}>
              <span>{item.quantity} × {item.title}</span>
              <strong>{formatMoney((entryQuotes[item.variantId]?.unitPriceCents ?? item.priceCents) * item.quantity, currency)}</strong>
            </li>
          ))}
        </ul>
        <dl>
          <div><dt>Subtotal</dt><dd>{formatMoney(quotedSubtotalCents, currency)}</dd></div>
          <div><dt>Shipping</dt><dd>{quotedShippingCents ? formatMoney(quotedShippingCents, currency) : "Free"}</dd></div>
          <div className="summary-total"><dt>{demoMode ? "Demo total" : "Total"}</dt><dd>{formatMoney(quotedSubtotalCents + quotedShippingCents, currency)}</dd></div>
          <div className="entry-total"><dt>Entries after payment</dt><dd>{estimatedEntries == null ? "Revalidated before payment" : formatEntries(estimatedEntries)}</dd></div>
        </dl>
        <button className="button button-primary button-block" disabled={pending || !quotesComplete} type="submit">
          <LockKeyhole aria-hidden="true" size={17} /> {pending
            ? "Processing…"
            : demoMode
              ? "Complete demo order"
              : "Continue to secure payment"}
        </button>
        {!quotesComplete ? <p className="form-alert" role="alert">One or more cart items changed. Return to the cart and refresh the selection before checkout.</p> : null}
        <p className="legal-short">{demoMode
          ? "No card information is requested in demo mode."
          : "Card details are entered on Stripe’s hosted, tokenized checkout and are not handled by this application."}</p>
        <p className="legal-short"><strong>NO PURCHASE NECESSARY.</strong> A purchase will not increase your chances of winning. <Link href={`/giveaways/${campaignSlug}/free-entry`}>Enter free</Link>.</p>
      </aside>
    </form>
  );
}
