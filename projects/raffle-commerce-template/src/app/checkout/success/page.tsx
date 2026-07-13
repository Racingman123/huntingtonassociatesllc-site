import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, Clock3, XCircle } from "lucide-react";
import { notFound } from "next/navigation";
import { ClearCartOnMount } from "@/components/checkout/clear-cart-on-mount";
import { getRequestTenant } from "@/server/auth/tenant";
import { getCheckoutReceipt } from "@/server/commerce/stripe-checkout";
import { formatEntries, formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Checkout status", robots: { index: false, follow: false } };

export default async function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ receipt?: string }>;
}) {
  const { receipt } = await searchParams;
  if (!receipt) notFound();
  const tenant = await getRequestTenant();
  const order = await getCheckoutReceipt(receipt, tenant.id);
  if (!order) notFound();

  const captured = order.paymentStatus === "CAPTURED" && order.status === "CONFIRMED";
  const cancelled = order.status === "CANCELLED" || order.paymentStatus === "FAILED";
  return (
    <main className="page-shell narrow-page">
      {captured && <ClearCartOnMount />}
      <section className="success-card">
        {captured
          ? <CheckCircle2 className="success-icon" aria-hidden="true" size={54} />
          : cancelled
            ? <XCircle className="success-icon" aria-hidden="true" size={54} />
            : <Clock3 className="success-icon" aria-hidden="true" size={54} />}
        <p className="eyebrow">{captured ? "ORDER CONFIRMED" : cancelled ? "CHECKOUT NOT COMPLETED" : "PAYMENT PROCESSING"}</p>
        <h1>{captured ? "You’re in." : cancelled ? "No charge was captured." : "We’re confirming your payment."}</h1>
        <p>
          Order <strong>{order.orderNumber}</strong> was prepared for {formatMoney(order.totalCents, order.currency)}.
          {!captured && !cancelled ? " This page will show entries only after the signed payment event is settled." : ""}
        </p>
        {captured && (
          <div className="success-entry-total">
            <span>Entries posted</span>
            <strong>{formatEntries(order.entryTotal)}</strong>
          </div>
        )}
        <p>{captured
          ? "Your payment, order, inventory and entry ledger were posted together from the verified provider event."
          : cancelled
            ? "Your reserved inventory was released. Your cart remains available if you want to try again."
            : "Stripe webhooks can arrive just after the browser redirect. Refresh in a moment; the redirect itself never grants entries."}</p>
        <div className="button-row">
          {captured
            ? <Link className="button button-primary" href="/account/entries">View my entries</Link>
            : !cancelled
              ? <Link className="button button-primary" href={`/checkout/success?receipt=${encodeURIComponent(receipt)}`}>Refresh status</Link>
              : <Link className="button button-primary" href="/checkout">Return to checkout</Link>}
          <Link className="button button-secondary" href="/shop">Keep browsing</Link>
        </div>
      </section>
    </main>
  );
}
