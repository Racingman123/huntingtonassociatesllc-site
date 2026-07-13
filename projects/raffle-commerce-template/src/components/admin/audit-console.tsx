import type { Route } from "next";
import { formatDateTime, titleCase } from "@/lib/format";
import Link from "next/link";
import type { getAdminAudit } from "@/server/admin/dal";
import { AdminBadge } from "./admin-badge";
import { AdminPageHeader } from "./admin-page-header";
import styles from "./admin.module.css";

type AuditData = Awaited<ReturnType<typeof getAdminAudit>>;

export function AuditConsole({ data }: { data: AuditData }) {
  const timezone = data.identity.tenant.timezone;
  const openTickets = data.tickets.filter((ticket) => ["OPEN", "PENDING"].includes(ticket.status));
  return (
    <>
      <AdminPageHeader
        eyebrow="Accountability and support"
        title="Audit & support"
        description="Who did what, to which resource, and when—alongside the customer-support queue that may require operational follow-up."
        meta={<>{data.events.length} audit records loaded<br />{data.tickets.length} support tickets loaded</>}
      />
      <section className={styles.metrics} aria-label="Audit metrics">
        <Metric label="Audit events" value={String(data.events.length)} meta="Up to 500 records" />
        <Metric label="Human actors" value={String(data.events.filter((item) => item.actorType !== "SYSTEM").length)} meta="Non-system events" />
        <Metric label="System events" value={String(data.events.filter((item) => item.actorType === "SYSTEM").length)} meta="Automated operations" />
        <Metric label="Support tickets" value={String(data.tickets.length)} meta="Up to 100 records" />
        <Metric label="Open tickets" value={String(openTickets.length)} meta="Open or pending" />
        <Metric label="Request-linked" value={String(data.events.filter((item) => item.requestId).length)} meta="Request id recorded" />
      </section>
      <div className={styles.gridTwo}>
        <section className={styles.panel}>
          <div className={styles.panelHeader}><div><h2>Audit event stream</h2><p>Event metadata is deliberately minimized in this read view.</p></div></div>
          {data.events.length ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>Recorded</th><th>Action</th><th>Actor</th><th>Resource</th><th>Request</th><th>Reason</th></tr></thead>
                <tbody>{data.events.map((event) => (
                  <tr key={event.id}>
                    <td className={styles.numeric}>{formatDateTime(event.createdAt, timezone)}</td>
                    <td><strong>{titleCase(event.action)}</strong></td>
                    <td><div className={styles.primaryCell}><strong>{titleCase(event.actorType)}</strong><span>{event.actorId ?? "System"}</span></div></td>
                    <td><div className={styles.primaryCell}><strong>{event.resourceType}</strong><span>{event.resourceId ?? "—"}</span></div></td>
                    <td className={styles.numeric}>{event.requestId ?? "—"}</td>
                    <td>{event.reason ?? "—"}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <div className={styles.empty}><strong>No audit events</strong>Operational state changes should append audit evidence.</div>}
        </section>
        <aside className={styles.panel}>
          <div className={styles.panelHeader}><div><h2>Support queue</h2><p>Message bodies stay out of the overview.</p></div></div>
          {data.tickets.length ? (
            <ul className={styles.readinessList}>{data.tickets.map((ticket) => (
              <li className={styles.readinessItem} key={ticket.id}>
                <div><strong><Link href={`/admin/support/${ticket.id}` as Route}>{ticket.subject}</Link></strong><p>{ticket.name} · {ticket.email}<br />Opened {formatDateTime(ticket.createdAt, timezone)}</p></div>
                <AdminBadge value={ticket.status} />
              </li>
            ))}</ul>
          ) : <div className={styles.empty}><strong>No support tickets</strong>The support queue is clear.</div>}
        </aside>
      </div>
    </>
  );
}

function Metric({ label, value, meta }: { label: string; value: string; meta: string }) {
  return <div className={styles.metric}><span className={styles.metricLabel}>{label}</span><strong className={styles.metricValue}>{value}</strong><span className={styles.metricMeta}>{meta}</span></div>;
}
