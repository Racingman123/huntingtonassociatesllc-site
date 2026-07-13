import { formatEntries, titleCase } from "@/lib/format";
import type { AccountLedgerItem } from "@/server/account/types";
import { StatusPill } from "./status-pill";
import styles from "./account.module.css";

function shortDate(value: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

export function EntryLedger({ items }: { items: AccountLedgerItem[] }) {
  if (!items.length) {
    return (
      <div className={styles.empty}>
        <div><strong>No ledger events yet</strong>Posted purchase and free-entry awards will appear here.</div>
      </div>
    );
  }
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Effective</th>
            <th>Campaign / source</th>
            <th>Event</th>
            <th>Reason</th>
            <th>Entry change</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const positive = BigInt(item.delta) >= 0n;
            return (
              <tr key={item.id}>
                <td className={styles.numeric}>{shortDate(item.effectiveAt)}</td>
                <td>
                  <div className={styles.primaryCell}>
                    <strong>{item.campaign.code}</strong>
                    <span>{item.sourceReference ?? titleCase(item.originType ?? "system")}</span>
                  </div>
                </td>
                <td><StatusPill value={item.kind} /></td>
                <td>{titleCase(item.reasonCode)}</td>
                <td className={`${styles.numeric} ${positive ? styles.positive : styles.negative}`}>
                  {positive ? "+" : ""}{formatEntries(item.delta)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

