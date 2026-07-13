import type { Route } from "next";
import Link from "next/link";
import { formatEntries, formatMoney } from "@/lib/format";
import type { AccountOrder } from "@/server/account/types";
import { StatusPill } from "./status-pill";
import styles from "./account.module.css";

function shortDate(value: Date) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(value);
}

export function OrderList({ orders }: { orders: AccountOrder[] }) {
  if (!orders.length) {
    return (
      <div className={styles.empty}>
        <div><strong>No orders yet</strong>Your qualifying orders will appear here after checkout.</div>
      </div>
    );
  }
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Order</th>
            <th>Payment</th>
            <th>Fulfillment</th>
            <th>Total</th>
            <th>Entries</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const href = `/account/orders/${encodeURIComponent(order.orderNumber)}` as Route;
            return (
              <tr key={order.id}>
                <td>
                  <div className={styles.primaryCell}>
                    <Link className={styles.tableLink} href={href}>{order.orderNumber}</Link>
                    <span>{shortDate(order.createdAt)} · {order.lines.length} line item(s)</span>
                  </div>
                </td>
                <td><StatusPill value={order.paymentStatus} /></td>
                <td><StatusPill value={order.fulfillmentStatus} /></td>
                <td className={styles.numeric}>{formatMoney(order.totalCents, order.currency)}</td>
                <td className={`${styles.numeric} ${styles.positive}`}>{formatEntries(order.entryTotal)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

