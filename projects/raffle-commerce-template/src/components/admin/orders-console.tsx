import { randomUUID } from "node:crypto";
import { formatDateTime, formatEntries, formatMoney } from "@/lib/format";
import type { getAdminOrders } from "@/server/admin/dal";
import { initiateStripeRefundAction } from "@/app/admin/orders/actions";
import { AdminBadge } from "./admin-badge";
import { AdminPageHeader } from "./admin-page-header";
import styles from "./admin.module.css";

type OrdersData = Awaited<ReturnType<typeof getAdminOrders>>;

export function OrdersConsole({
  data,
  result,
}: {
  data: OrdersData;
  result: { result: string | null; error: string | null };
}) {
  const currency = data.identity.tenant.currency;
  const timezone = data.identity.tenant.timezone;
  const captured = data.orders.filter((order) => ["CAPTURED", "PAID"].includes(order.paymentStatus));
  const capturedRevenue = captured.reduce((sum, order) => sum + order.totalCents, 0);
  const entryTotal = data.orders.reduce((sum, order) => sum + BigInt(order.entryTotal), 0n);
  const unfulfilled = data.orders.filter((order) => order.fulfillmentStatus === "UNFULFILLED").length;
  return (
    <>
      {result.result === "refund-requested" ? (
        <div className={styles.successNotice}>Stripe accepted the idempotent refund request. Money and entry consequences remain pending until the signed webhook confirms settlement.</div>
      ) : null}
      {result.error ? (
        <div className={styles.errorNotice}>The refund request was not accepted. Review the allocation and evidence, or resume the pending request shown on the order.</div>
      ) : null}
      <AdminPageHeader
        eyebrow="Commerce operations"
        title="Orders"
        description="Tenant-scoped payment, fulfillment, item, and recorded entry totals. Provider events remain the payment source of truth."
        meta={<>{data.orders.length} most recent orders<br />Newest first</>}
      />
      <section className={styles.metrics} aria-label="Order metrics">
        <Metric label="Orders loaded" value={String(data.orders.length)} meta="Up to 250 records" />
        <Metric label="Captured" value={String(captured.length)} meta="Paid payment states" />
        <Metric label="Revenue" value={formatMoney(capturedRevenue, currency)} meta="Captured records loaded" />
        <Metric label="Entries quoted" value={formatEntries(entryTotal)} meta="Recorded order totals" />
        <Metric label="Unfulfilled" value={String(unfulfilled)} meta="Requires fulfillment" />
        <Metric label="Refunded" value={String(data.orders.filter((order) => order.paymentStatus === "REFUNDED").length)} meta="Entry reversal review" />
      </section>
      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div><h2>Order register</h2><p>Customer identifiers are shown only inside this staff-authorized console.</p></div>
        </div>
        {data.orders.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Order</th><th>Customer</th><th>Campaign</th><th>Payment</th><th>Fulfillment</th><th>Total</th><th>Entries</th><th>Placed</th></tr></thead>
              <tbody>
                {data.orders.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <details className={styles.details}>
                        <summary>{order.orderNumber}</summary>
                        <div className={styles.detailList}>
                          {order.lines.map((line) => (
                            <span key={line.id}>{line.quantity}× {line.productTitle}{line.variantTitle ? ` / ${line.variantTitle}` : ""} · {formatEntries(line.entries)} entries</span>
                          ))}
                          {order.latestPayment && <span>{order.latestPayment.provider} · {order.latestPayment.status} · {formatMoney(order.latestPayment.amountCents, order.currency)}</span>}
                          {order.refunds.map((refund) => (
                            <span key={refund.id}>
                              Refund {formatMoney(refund.amountCents, refund.currency)} · {refund.status} · merchandise {formatMoney(refund.merchandiseCents, refund.currency)} / shipping {formatMoney(refund.shippingCents, refund.currency)} / tax {formatMoney(refund.taxCents, refund.currency)} · {formatEntries(refund.entriesReversed)} entry reversal
                            </span>
                          ))}
                          <RefundOperation order={order} role={data.identity.role} />
                        </div>
                      </details>
                    </td>
                    <td><div className={styles.primaryCell}><strong>{order.customerName}</strong><span>{order.email}</span></div></td>
                    <td><div className={styles.primaryCell}><strong>{order.campaign?.code ?? "—"}</strong><span>{order.campaign?.title ?? "No campaign"}</span></div></td>
                    <td><AdminBadge value={order.paymentStatus} /></td>
                    <td><AdminBadge value={order.fulfillmentStatus} /></td>
                    <td className={styles.numeric}>{formatMoney(order.totalCents, order.currency)}</td>
                    <td className={`${styles.numeric} ${styles.positive}`}>{formatEntries(order.entryTotal)}</td>
                    <td className={styles.numeric}>{formatDateTime(order.createdAt, timezone)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className={styles.empty}><strong>No orders</strong>Orders will appear after checkout creation.</div>}
      </section>
    </>
  );
}

function decimalAmount(cents: number) {
  return (cents / 100).toFixed(2);
}

function RefundOperation({ order, role }: { order: OrdersData["orders"][number]; role: string }) {
  if (!["ADMIN", "OPERATIONS"].includes(role)) return null;
  if (order.latestPayment?.provider !== "STRIPE") return null;
  if (!["CAPTURED", "PARTIALLY_REFUNDED"].includes(order.paymentStatus)) return null;

  const pending = order.refunds.find((refund) => refund.status === "PENDING");
  const processing = order.refunds.find((refund) => refund.status === "PROCESSING");
  if (processing) {
    return <span>Provider refund {processing.providerRefundId ?? processing.id} is awaiting signed webhook settlement.</span>;
  }
  const completed = order.refunds.filter((refund) => refund.status === "COMPLETED");
  const remainingMerchandise = order.lines.reduce((sum, line) => sum + line.qualifyingCents, 0)
    - completed.reduce((sum, refund) => sum + refund.merchandiseCents, 0);
  const remainingShipping = order.shippingCents
    - completed.reduce((sum, refund) => sum + refund.shippingCents, 0);
  const remainingTax = order.taxCents
    - completed.reduce((sum, refund) => sum + refund.taxCents, 0);
  const defaults = pending ?? {
    amountCents: remainingMerchandise + remainingShipping + remainingTax,
    merchandiseCents: remainingMerchandise,
    shippingCents: remainingShipping,
    taxCents: remainingTax,
    reason: "",
    evidence: "",
    providerReason: "requested_by_customer",
    idempotencyKey: `admin-refund:${order.id}:${randomUUID()}`,
  };
  if (defaults.amountCents <= 0) return null;

  return (
    <details className={styles.operationDetails}>
      <summary>{pending ? "Resume pending Stripe request" : "Initiate Stripe refund"}</summary>
      <form action={initiateStripeRefundAction} className={styles.approvalForm}>
        <input type="hidden" name="orderId" value={order.id} />
        <input type="hidden" name="idempotencyKey" value={defaults.idempotencyKey} />
        <label>Total refund ({order.currency})
          <input name="amount" inputMode="decimal" required defaultValue={decimalAmount(defaults.amountCents)} />
        </label>
        <div className={styles.refundAllocationGrid}>
          <label>Merchandise
            <input name="merchandiseAmount" inputMode="decimal" required defaultValue={decimalAmount(defaults.merchandiseCents)} />
          </label>
          <label>Shipping
            <input name="shippingAmount" inputMode="decimal" required defaultValue={decimalAmount(defaults.shippingCents)} />
          </label>
          <label>Tax
            <input name="taxAmount" inputMode="decimal" required defaultValue={decimalAmount(defaults.taxCents)} />
          </label>
        </div>
        <label>Provider reason
          <select name="providerReason" required defaultValue={defaults.providerReason}>
            <option value="requested_by_customer">Requested by customer</option>
            <option value="duplicate">Duplicate charge</option>
            <option value="fraudulent">Fraudulent charge</option>
          </select>
        </label>
        <label>Operational reason
          <textarea name="reason" required minLength={5} maxLength={500} defaultValue={defaults.reason} placeholder="Why this exact refund is authorized" />
        </label>
        <label>Evidence reference
          <input name="evidence" required minLength={3} maxLength={1000} defaultValue={defaults.evidence} placeholder="Return RMA, support case, or evidence URL" />
        </label>
        <label><input type="checkbox" name="confirmed" required />I verified the total and its merchandise, shipping, and tax allocation. Stripe will receive this request.</label>
        <button className={styles.operationButton} type="submit">{pending ? "Resume request" : "Create Stripe refund"}</button>
      </form>
    </details>
  );
}

function Metric({ label, value, meta }: { label: string; value: string; meta: string }) {
  return <div className={styles.metric}><span className={styles.metricLabel}>{label}</span><strong className={styles.metricValue}>{value}</strong><span className={styles.metricMeta}>{meta}</span></div>;
}
