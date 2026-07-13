import type { Metadata } from "next";
import Link from "next/link";
import { AccountPageHeader } from "@/components/account/page-header";
import { EntryLedger } from "@/components/account/entry-ledger";
import { OrderList } from "@/components/account/order-list";
import { StatusPill } from "@/components/account/status-pill";
import { formatEntries, formatMoney } from "@/lib/format";
import { getAccountData } from "@/server/account/dal";
import styles from "@/components/account/account.module.css";

export const metadata: Metadata = { title: "My account" };

export default async function AccountPage() {
  const data = await getAccountData();
  return (
    <>
      <AccountPageHeader
        kicker="Customer account"
        title={`Hi, ${data.viewer.name.split(" ")[0]}.`}
        description="This is the source-of-truth view of your orders and posted promotional entries."
        action={<StatusPill value="ACTIVE" />}
      />
      <section className={styles.metrics} aria-label="Account summary">
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Active entries</span>
          <strong className={styles.metricValue}>{formatEntries(data.totals.activeEntries)}</strong>
          <span className={styles.metricMeta}>Across {data.entryPools.length} campaign pool(s)</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Orders</span>
          <strong className={styles.metricValue}>{data.totals.orderCount}</strong>
          <span className={styles.metricMeta}>All-time account history</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Captured spend</span>
          <strong className={styles.metricValue}>{formatMoney(data.totals.capturedSpendCents, data.viewer.tenant.currency)}</strong>
          <span className={styles.metricMeta}>Paid orders only</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Ledger events</span>
          <strong className={styles.metricValue}>{data.ledger.length}</strong>
          <span className={styles.metricMeta}>Grants and reversals</span>
        </div>
      </section>

      <div className={styles.gridTwo}>
        <div className={styles.stack}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2>Recent orders</h2>
              <Link className={styles.panelLink} href="/account/orders">View all</Link>
            </div>
            <OrderList orders={data.orders.slice(0, 4)} />
          </section>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2>Recent entry activity</h2>
              <Link className={styles.panelLink} href="/account/entries">Full ledger</Link>
            </div>
            <EntryLedger items={data.ledger.slice(0, 6)} />
          </section>
        </div>
        <aside className={styles.stack}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}><h2>Campaign entry pools</h2></div>
            <div className={styles.panelBody}>
              {data.entryPools.length ? (
                <ul className={styles.poolList}>
                  {data.entryPools.map((pool) => (
                    <li className={styles.poolItem} key={pool.id}>
                      <div>
                        <strong>{pool.campaign.code}</strong>
                        <span>{pool.campaign.title}</span>
                      </div>
                      <span className={styles.poolBalance}>{formatEntries(pool.balance)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className={styles.empty}><div><strong>No entry pools</strong>Eligible entries will create a campaign pool.</div></div>
              )}
            </div>
          </section>
          <section className={styles.panel}>
            <div className={styles.panelHeader}><h2>Entry transparency</h2></div>
            <div className={styles.panelBody}>
              <p className={styles.settingsCopy}>
                Each posted balance change records its effective time, campaign, origin, reason, and source reference. Returns and disputes appear as separate reversal events; history is never silently rewritten.
              </p>
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
