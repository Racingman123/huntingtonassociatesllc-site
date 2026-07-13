import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminBadge } from "@/components/admin/admin-badge";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import styles from "@/components/admin/admin.module.css";
import { formatDateTime } from "@/lib/format";
import { getAdminSupportTicket } from "@/server/admin/dal";
import { updateSupportTicketAction } from "./actions";

export const metadata: Metadata = { title: "Support ticket · Operations", robots: { index: false, follow: false } };

export default async function AdminSupportTicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ ticketId: string }>;
  searchParams: Promise<{ updated?: string; error?: string }>;
}) {
  const [{ ticketId }, query] = await Promise.all([params, searchParams]);
  const data = await getAdminSupportTicket(ticketId);
  if (!data) notFound();
  const role = data.identity.role.toUpperCase();
  const canManage = ["ADMIN", "OPERATIONS", "SUPPORT"].includes(role);
  const replySubject = encodeURIComponent(`Re: ${data.ticket.subject} [${data.ticket.id.slice(-8).toUpperCase()}]`);
  return (
    <>
      <AdminPageHeader
        eyebrow="Customer support"
        title={data.ticket.subject}
        description={`Reference ${data.ticket.id.slice(-8).toUpperCase()} · opened ${formatDateTime(data.ticket.createdAt, data.identity.tenant.timezone)}`}
        meta={<><AdminBadge value={data.ticket.status} /></>}
      />
      {query.updated ? <div className={styles.successNotice}>Ticket status request processed; state changes are in the audit trail.</div> : null}
      {query.error ? <div className={styles.errorNotice}>The requested transition was not applied.</div> : null}
      <div className={styles.gridTwo}>
        <section className={styles.panel}>
          <div className={styles.panelHeader}><div><h2>Customer message</h2><p>Untrusted visitor content is rendered as text.</p></div></div>
          <div className={styles.supportMessage}>
            <dl>
              <div><dt>Name</dt><dd>{data.ticket.name}</dd></div>
              <div><dt>Email</dt><dd><a href={`mailto:${data.ticket.email}?subject=${replySubject}`}>{data.ticket.email}</a></dd></div>
              <div><dt>Account</dt><dd>{data.ticket.user ? `${data.ticket.user.name} · ${data.ticket.user.email}` : "Guest"}</dd></div>
            </dl>
            <div className={styles.messageBody}>{data.ticket.message}</div>
          </div>
        </section>
        <aside className={styles.panel}>
          <div className={styles.panelHeader}><div><h2>Controlled status</h2><p>Record why the queue state changed.</p></div></div>
          <div className={styles.supportMessage}>
            {canManage ? (
              <form action={updateSupportTicketAction} className={styles.approvalForm}>
                <input name="ticketId" type="hidden" value={data.ticket.id} />
                <label>New status<select name="status" defaultValue={data.ticket.status} required>
                  {(["OPEN", "PENDING", "RESOLVED", "CLOSED"] as const).map((status) => <option key={status} value={status}>{status}</option>)}
                </select></label>
                <label>Decision notes<textarea name="reason" required minLength={5} maxLength={500} /></label>
                <button className={styles.operationButton} type="submit">Update and audit</button>
              </form>
            ) : <p>Your role may read this ticket but cannot change its queue state.</p>}
            <p><Link className={styles.sidebarButton} href="/admin/audit">Back to audit & support</Link></p>
          </div>
        </aside>
      </div>
    </>
  );
}
