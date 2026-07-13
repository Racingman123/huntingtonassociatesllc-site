import type { Metadata } from "next";
import Link from "next/link";
import { AccountPageHeader } from "@/components/account/page-header";
import { StatusPill } from "@/components/account/status-pill";
import { formatDateTime, formatEntries, formatMoney, titleCase } from "@/lib/format";
import { getOwnedOrder } from "@/server/account/dal";
import styles from "@/components/account/account.module.css";

export const metadata: Metadata = { title: "Order details" };

export default async function AccountOrderPage({
  params,
}: {
  params: Promise<{ orderNumber: string }>;
}) {
  const { orderNumber } = await params;
  const order = await getOwnedOrder(orderNumber);
  const address = order.shippingAddress;
  return (
    <>
      <AccountPageHeader
        kicker="Order detail"
        title={order.orderNumber}
        description={`Placed ${formatDateTime(order.createdAt)}. Entry awards shown here are the immutable values recorded at checkout.`}
        action={<Link className={styles.smallButton} href="/account/orders">Back to orders</Link>}
      />
      <div className={styles.detailGrid}>
        <div className={styles.stack}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2>Line items</h2>
              <StatusPill value={order.status} />
            </div>
            <ul className={styles.lineList}>
              {order.lines.map((line) => (
                <li className={styles.lineItem} key={line.id}>
                  <div>
                    <h3>{line.title}</h3>
                    <div className={styles.lineMeta}>
                      {line.variantTitle ? `${line.variantTitle} · ` : ""}Qty {line.quantity}
                      {line.sku ? ` · ${line.sku}` : ""}
                    </div>
                  </div>
                  <div className={styles.lineNumbers}>
                    <strong>{formatMoney(line.unitPriceCents * line.quantity, order.currency)}</strong>
                    <span>+{formatEntries(line.entries)} entries</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
          <section className={styles.panel}>
            <div className={styles.panelHeader}><h2>Entry posting proof</h2></div>
            {order.entitlements.length ? (
              <ul className={styles.proofList}>
                {order.entitlements.map((entitlement) => (
                  <li className={styles.proofItem} key={entitlement.id}>
                    <div className={styles.proofHeading}>
                      <strong>{titleCase(entitlement.originType)} · {formatEntries(entitlement.originalEntries)} entries</strong>
                      <StatusPill value={entitlement.status} />
                    </div>
                    <div className={styles.proofMeta}>
                      Effective {formatDateTime(entitlement.effectiveAt)} · entitlement {entitlement.id}
                    </div>
                    {entitlement.ledgerEvents.map((event) => (
                      <div className={styles.proofMeta} key={event.id}>
                        {titleCase(event.kind)} {BigInt(event.delta) >= 0n ? "+" : ""}{formatEntries(event.delta)} · {titleCase(event.reasonCode)} · recorded {formatDateTime(event.recordedAt)}
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            ) : (
              <div className={styles.empty}><div><strong>No entry entitlements</strong>This order did not post promotional entries.</div></div>
            )}
          </section>
        </div>
        <aside className={styles.stack}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}><h2>Summary</h2></div>
            <div className={styles.panelBody}>
              <dl className={styles.totals}>
                <div className={styles.totalRow}><dt>Subtotal</dt><dd>{formatMoney(order.subtotalCents, order.currency)}</dd></div>
                {order.discountCents > 0 && <div className={styles.totalRow}><dt>Discount</dt><dd>−{formatMoney(order.discountCents, order.currency)}</dd></div>}
                <div className={styles.totalRow}><dt>Shipping</dt><dd>{formatMoney(order.shippingCents, order.currency)}</dd></div>
                <div className={styles.totalRow}><dt>Tax</dt><dd>{formatMoney(order.taxCents, order.currency)}</dd></div>
                <div className={`${styles.totalRow} ${styles.grandTotal}`}><dt>Total</dt><dd>{formatMoney(order.totalCents, order.currency)}</dd></div>
                <div className={`${styles.totalRow} ${styles.grandTotal}`}><dt>Entries</dt><dd>{formatEntries(order.entryTotal)}</dd></div>
              </dl>
            </div>
          </section>
          <section className={styles.panel}>
            <div className={styles.panelHeader}><h2>Status</h2></div>
            <div className={styles.panelBody}>
              <div className={styles.stack}>
                <div><span className={styles.metricLabel}>Payment</span><StatusPill value={order.paymentStatus} /></div>
                <div><span className={styles.metricLabel}>Fulfillment</span><StatusPill value={order.fulfillmentStatus} /></div>
              </div>
            </div>
          </section>
          {address && (
            <section className={styles.panel}>
              <div className={styles.panelHeader}><h2>Shipping & contact</h2></div>
              <div className={styles.panelBody}>
                <address className={styles.address}>
                  {[address.line1, address.line2, [address.city, address.region].filter(Boolean).join(", "), address.postalCode, address.country]
                    .filter(Boolean)
                    .map((line) => <div key={line}>{line}</div>)}
                </address>
                {address.phone && <p>Phone: <a href={`tel:${address.phone}`}>{address.phone}</a></p>}
              </div>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
