import type { Metadata } from "next";
import { AccountPageHeader } from "@/components/account/page-header";
import { EntryLedger } from "@/components/account/entry-ledger";
import { formatEntries } from "@/lib/format";
import { getAccountData } from "@/server/account/dal";
import styles from "@/components/account/account.module.css";

export const metadata: Metadata = { title: "My entry ledger" };

export default async function AccountEntriesPage() {
  const data = await getAccountData();
  return (
    <>
      <AccountPageHeader
        kicker="Auditable entry history"
        title="Entry ledger"
        description="Append-only grants and reversals, tied to their campaign and originating order or free-entry confirmation."
      />
      <section className={styles.metrics} aria-label="Entry totals">
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Current balance</span>
          <strong className={styles.metricValue}>{formatEntries(data.totals.activeEntries)}</strong>
          <span className={styles.metricMeta}>Sum of campaign account balances</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Campaign pools</span>
          <strong className={styles.metricValue}>{data.entryPools.length}</strong>
          <span className={styles.metricMeta}>Independent balances</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Recorded events</span>
          <strong className={styles.metricValue}>{data.ledger.length}</strong>
          <span className={styles.metricMeta}>Newest first</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Eligibility attested</span>
          <strong className={styles.metricValue}>{data.entrant?.eligibilityAttested ? "Yes" : "Not yet"}</strong>
          <span className={styles.metricMeta}>Campaign-specific rules still apply</span>
        </div>
      </section>
      <section className={styles.panel}>
        <EntryLedger items={data.ledger} />
      </section>
    </>
  );
}

