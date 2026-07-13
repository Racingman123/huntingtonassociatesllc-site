import { formatDateTime, formatEntries } from "@/lib/format";
import { reviewAmoeAction } from "@/app/admin/amoe/actions";
import type { getAdminAmoe } from "@/server/admin/dal";
import { AdminBadge } from "./admin-badge";
import { AdminPageHeader } from "./admin-page-header";
import styles from "./admin.module.css";

type AmoeData = Awaited<ReturnType<typeof getAdminAmoe>>;

export function AmoeConsole({ data, result }: { data: AmoeData; result: { reviewed: string | null; error: string | null } }) {
  const timezone = data.identity.tenant.timezone;
  const count = (status: string) => data.counts[status] ?? 0;
  return (
    <>
      <AdminPageHeader
        eyebrow="No-purchase entry operations"
        title="AMOE queue"
        description="Alternative-method submissions, eligibility context, review outcome, and the resulting entry entitlement in one queue."
        meta={<>{data.submissions.length} submissions loaded<br />Every decision is audited</>}
      />
      {result.reviewed ? <div className={styles.successNotice}>Submission {result.reviewed}. The queue and ledger were refreshed.</div> : null}
      {result.error ? <div className={styles.errorNotice}>The review could not be completed. Check role, campaign state, evidence, and entrant cap.</div> : null}
      <section className={styles.metrics} aria-label="AMOE metrics">
        <Metric label="Total loaded" value={String(data.submissions.length)} meta="Up to 300 records" />
        <Metric label="Pending" value={String(count("PENDING"))} meta="Awaiting human review" />
        <Metric label="In review" value={String(count("REVIEW"))} meta="Assigned queue items" />
        <Metric label="Approved" value={String(count("APPROVED"))} meta="Entitlement expected" />
        <Metric label="Rejected" value={String(count("REJECTED"))} meta="Reason must be present" />
        <Metric label="Posted entries" value={formatEntries(data.submissions.reduce((sum, item) => sum + BigInt(item.entitlement?.originalEntries ?? "0"), 0n))} meta="Approved entitlements loaded" />
      </section>
      <div className={styles.notice}>
        A shared device or IP address is not by itself a rejection reason. Decisions require a written rationale, authenticated operator identity, tenant scope, and a matching immutable audit event.
      </div>
      <section className={styles.panel} style={{ marginTop: 14 }}>
        <div className={styles.panelHeader}><div><h2>Submission register</h2><p>Purchase and marketing consent are intentionally absent from AMOE eligibility.</p></div></div>
        {data.submissions.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Submitted</th><th>Confirmation</th><th>Entrant</th><th>Campaign</th><th>Requested</th><th>Status</th><th>Entitlement</th><th>Review</th></tr></thead>
              <tbody>
                {data.submissions.map((submission) => (
                  <tr key={submission.id}>
                    <td className={styles.numeric}>{formatDateTime(submission.submittedAt, timezone)}</td>
                    <td><div className={styles.primaryCell}><strong>{submission.confirmationCode}</strong><span>{submission.method} · rules v{submission.rulesVersion}</span></div></td>
                    <td><div className={styles.primaryCell}><strong>{submission.entrant.name}</strong><span>{submission.entrant.normalizedEmail} · {submission.submittedPhone ?? "No submitted phone"}</span><span>{submission.entrant.region ?? "—"} {submission.entrant.postalCode ?? ""}</span></div></td>
                    <td><div className={styles.primaryCell}><strong>{submission.campaign.code}</strong><span>{submission.campaign.title}</span></div></td>
                    <td className={`${styles.numeric} ${styles.positive}`}>{formatEntries(submission.entriesRequested)}</td>
                    <td><AdminBadge value={submission.status} /></td>
                    <td>{submission.entitlement ? <div className={styles.primaryCell}><AdminBadge value={submission.entitlement.status} /><span>{formatEntries(submission.entitlement.originalEntries)} posted</span></div> : <span className={styles.secondary}>Not posted</span>}</td>
                    <td>{["PENDING", "REVIEW"].includes(submission.status) ? (
                      <form action={reviewAmoeAction} className={styles.reviewForm}>
                        <input name="submissionId" type="hidden" value={submission.id} />
                        <label>
                          <span className={styles.visuallyHidden}>Review rationale for {submission.confirmationCode}</span>
                          <input name="reason" placeholder="Evidence-based rationale" required minLength={5} maxLength={500} />
                        </label>
                        <div>
                          <button name="decision" type="submit" value="APPROVE">Approve</button>
                          <button data-tone="danger" name="decision" type="submit" value="REJECT">Reject</button>
                        </div>
                      </form>
                    ) : <div className={styles.primaryCell}><strong>{submission.reviewedBy ?? "Unassigned"}</strong><span>{submission.reviewedAt ? formatDateTime(submission.reviewedAt, timezone) : submission.rejectionReason ?? "Awaiting review"}</span></div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className={styles.empty}><strong>No AMOE submissions</strong>Free-entry submissions will appear here.</div>}
      </section>
    </>
  );
}

function Metric({ label, value, meta }: { label: string; value: string; meta: string }) {
  return <div className={styles.metric}><span className={styles.metricLabel}>{label}</span><strong className={styles.metricValue}>{value}</strong><span className={styles.metricMeta}>{meta}</span></div>;
}
