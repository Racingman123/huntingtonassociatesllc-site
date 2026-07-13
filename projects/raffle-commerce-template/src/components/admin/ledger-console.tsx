import { formatDateTime, formatEntries, titleCase } from "@/lib/format";
import type { getAdminLedger } from "@/server/admin/dal";
import { AdminBadge } from "./admin-badge";
import { AdminPageHeader } from "./admin-page-header";
import styles from "./admin.module.css";

type LedgerData = Awaited<ReturnType<typeof getAdminLedger>>;

export function LedgerConsole({ data }: { data: LedgerData }) {
  const timezone = data.identity.tenant.timezone;
  const grants = data.events.filter((event) => BigInt(event.delta) > 0n);
  const reversals = data.events.filter((event) => BigInt(event.delta) < 0n);
  const posted = grants.reduce((sum, event) => sum + BigInt(event.delta), 0n);
  const reversed = reversals.reduce((sum, event) => sum + -BigInt(event.delta), 0n);
  return (
    <>
      <AdminPageHeader
        eyebrow="Entry accounting"
        title="Entry ledger"
        description="Append-only promotional entry events across purchase, free-entry, refund, dispute, and administrative origins."
        meta={<>{data.events.length} events loaded<br />Effective time, then id</>}
      />
      <section className={styles.metrics} aria-label="Entry ledger metrics">
        <Metric label="Entry accounts" value={String(data.accountCount)} meta="Campaign / entrant pairs" />
        <Metric label="Current balance" value={formatEntries(data.totalBalance)} meta="Account liability" />
        <Metric label="Events loaded" value={String(data.events.length)} meta="Up to 500 records" />
        <Metric label="Granted" value={formatEntries(posted)} meta="Positive loaded deltas" />
        <Metric label="Reversed" value={formatEntries(reversed)} meta="Absolute negative deltas" />
        <Metric label="Net loaded" value={formatEntries(posted - reversed)} meta="Loaded event window" />
      </section>
      <section className={styles.panel}>
        <div className={styles.panelHeader}><div><h2>Immutable event register</h2><p>Source references join each event back to an entitlement without rewriting earlier history.</p></div></div>
        {data.events.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Effective</th><th>Entrant</th><th>Campaign</th><th>Origin</th><th>Event</th><th>Reason</th><th>Delta</th><th>Actor</th></tr></thead>
              <tbody>
                {data.events.map((event) => {
                  const positive = BigInt(event.delta) >= 0n;
                  return (
                    <tr key={event.id}>
                      <td className={styles.numeric}>{formatDateTime(event.effectiveAt, timezone)}</td>
                      <td><div className={styles.primaryCell}><strong>{event.entrant.name}</strong><span>{event.entrant.normalizedEmail}</span></div></td>
                      <td><div className={styles.primaryCell}><strong>{event.campaign.code}</strong><span>{event.campaign.title}</span></div></td>
                      <td><div className={styles.primaryCell}><strong>{titleCase(event.originType ?? "system")}</strong><span>{event.sourceReference ?? "No external reference"}</span></div></td>
                      <td><AdminBadge value={event.kind} /></td>
                      <td>{titleCase(event.reasonCode)}</td>
                      <td className={`${styles.numeric} ${positive ? styles.positive : styles.negative}`}>{positive ? "+" : ""}{formatEntries(event.delta)}</td>
                      <td><div className={styles.primaryCell}><strong>{titleCase(event.actorType)}</strong><span>{event.actorId ?? "—"}</span></div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <div className={styles.empty}><strong>No ledger events</strong>Posted entitlements will generate entry events.</div>}
      </section>
    </>
  );
}

function Metric({ label, value, meta }: { label: string; value: string; meta: string }) {
  return <div className={styles.metric}><span className={styles.metricLabel}>{label}</span><strong className={styles.metricValue}>{value}</strong><span className={styles.metricMeta}>{meta}</span></div>;
}

