import { formatDateTime, formatEntries, formatMoney } from "@/lib/format";
import {
  approveAdjustmentEvidenceAction,
  approveSnapshotAction,
  buildSnapshotAction,
  conductDrawAction,
  decideCandidateAction,
  decideAdjustmentComplianceAction,
  publishWinnerAction,
  recordCandidateContactAction,
  recordWinnerFulfillmentAction,
} from "@/app/admin/draws/actions";
import type { getAdminDraws } from "@/server/admin/dal";
import { AdminBadge } from "./admin-badge";
import { AdminPageHeader } from "./admin-page-header";
import styles from "./admin.module.css";

type DrawData = Awaited<ReturnType<typeof getAdminDraws>>;

function fingerprint(value: string | null) {
  if (!value) return "Not recorded";
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-8)}` : value;
}

export function DrawsConsole({ data, result }: { data: DrawData; result: { result: string | null; error: string | null } }) {
  const timezone = data.identity.tenant.timezone;
  const role = data.identity.role.toUpperCase();
  const canOperate = ["ADMIN", "OPERATIONS"].includes(role);
  const canWitness = role === "COMPLIANCE";
  const canManageContact = ["ADMIN", "OPERATIONS", "COMPLIANCE"].includes(role);
  const canDecideCandidate = ["ADMIN", "COMPLIANCE"].includes(role);
  const canPublishWinner = role === "ADMIN";
  const canRecordFulfillment = ["ADMIN", "OPERATIONS"].includes(role);
  const canApproveAdjustmentEvidence = ["ADMIN", "OPERATIONS"].includes(role);
  const canDecideAdjustment = role === "COMPLIANCE";
  const now = new Date();
  const snapshots = data.campaigns.flatMap((campaign) => campaign.snapshots);
  const draws = data.campaigns.flatMap((campaign) => campaign.draws);
  const winners = data.campaigns.flatMap((campaign) => campaign.winners);
  const candidates = draws.flatMap((draw) => draw.candidates);
  const adjustments = data.campaigns.flatMap((campaign) => campaign.adjustmentRequests);
  return (
    <>
      <AdminPageHeader
        eyebrow="Controlled winner selection"
        title="Draws & winners"
        description="Snapshot sealing, random-draw provenance, ordered candidates, verification, publication, and fulfillment state."
        meta={<>Two-person approval enforced<br />No seed material is exposed</>}
      />
      {result.result ? <div className={styles.successNotice}>Operation completed: {result.result.replaceAll("-", " ")}.</div> : null}
      {result.error ? <div className={styles.errorNotice}>Operation stopped safely. Review timing, unresolved queues, role separation, approvals, and audit evidence.</div> : null}
      <section className={styles.metrics} aria-label="Draw metrics">
        <Metric label="Snapshots" value={String(snapshots.length)} meta={`${snapshots.filter((item) => item.status === "SEALED").length} sealed`} />
        <Metric label="Draw records" value={String(draws.length)} meta={`${draws.filter((item) => item.conductedAt).length} conducted`} />
        <Metric label="Candidates" value={String(candidates.length)} meta="Ordered selections" />
        <Metric label="Entry cases" value={String(adjustments.length)} meta={`${adjustments.filter((item) => ["PENDING", "REVIEW", "APPROVED"].includes(item.status)).length} unresolved`} />
        <Metric label="Verified" value={String(candidates.filter((item) => item.verifiedAt).length)} meta="Candidate checks complete" />
        <Metric label="Winners" value={String(winners.length)} meta={`${winners.filter((item) => item.status === "PUBLISHED").length} published`} />
        <Metric label="Fulfilled" value={String(winners.filter((item) => item.fulfilledAt).length)} meta="Prize delivery recorded" />
      </section>

      <div className={styles.stack}>
        {data.campaigns.map((campaign) => (
          <article className={styles.campaignCard} key={campaign.id}>
            <div className={styles.campaignHead}>
              <div>
                <span className={styles.campaignCode}>{campaign.code} · closed {formatDateTime(campaign.endsAt, timezone)}</span>
                <h2>{campaign.title}</h2>
                <div className={styles.campaignMeta}>
                  <span>Scheduled draw: {campaign.drawAt ? formatDateTime(campaign.drawAt, timezone) : "Not scheduled"}</span>
                  <span>{campaign.snapshots.length} snapshot(s)</span>
                  <span>{campaign.draws.length} draw(s)</span>
                  <span>{campaign.winners.length} winner record(s)</span>
                </div>
              </div>
              <AdminBadge value={campaign.status} />
            </div>
            {canOperate && (campaign.freeEntryEndsAt > campaign.endsAt ? campaign.freeEntryEndsAt : campaign.endsAt) <= now && ["LIVE", "ENTRY_CLOSED", "RECONCILING"].includes(campaign.status) ? (
              <div className={styles.operationBar}>
                <div><strong>Reconciliation ready?</strong><span>This freezes ledger writes, verifies ledger balances, and builds a reviewable range snapshot.</span></div>
                <form action={buildSnapshotAction}>
                  <input name="campaignId" type="hidden" value={campaign.id} />
                  <button className={styles.operationButton} type="submit">Build snapshot</button>
                </form>
              </div>
            ) : null}
            {campaign.adjustmentRequests.length ? (
              <section className={styles.drawColumn} aria-label={`Entry adjustment cases for ${campaign.title}`}>
                <h3>Post-freeze entry cases</h3>
                <p className={styles.secondary}>Provider-confirmed money state is final. These controls resolve entry consequences without silently rewriting a sealed or drawn population.</p>
                <ul className={styles.recordList}>
                  {campaign.adjustmentRequests.map((request) => {
                    const evidenceApproval = request.approvals.find((approval) => approval.kind === "EVIDENCE_REVIEW");
                    const decisionApproval = request.approvals.find((approval) => approval.kind === "COMPLIANCE_DECISION");
                    const hasDraw = campaign.draws.some((draw) => !["VOID", "CANCELLED"].includes(draw.status));
                    const isPositiveGrant = BigInt(request.delta) > 0n;
                    const sourceOrder = request.refund?.order.orderNumber
                      ?? request.subscriptionCycle?.order.orderNumber
                      ?? "Entry case";
                    return (
                      <li className={styles.record} key={request.id}>
                        <div className={styles.recordHead}>
                          <strong>{sourceOrder}</strong>
                          <AdminBadge value={request.status} />
                        </div>
                        <p>
                          {request.refund
                            ? `${formatMoney(request.refund.amountCents, request.refund.currency)} refunded`
                            : request.subscriptionCycle
                              ? `${formatMoney(request.subscriptionCycle.order.totalCents, request.subscriptionCycle.order.currency)} paid · membership cycle ${request.subscriptionCycle.cycleNumber}`
                              : "Source unavailable"}
                          {` · ${formatEntries(request.delta)} entry delta`}
                          <br />{request.entrant.name} · {request.entrant.normalizedEmail}
                        </p>
                        <p>
                          Opened {formatDateTime(request.createdAt, timezone)}<br />
                          Provider reference {fingerprint(request.refund?.providerRefundId ?? request.subscriptionCycle?.providerInvoiceId ?? request.evidenceRef)}<br />
                          Disposition {request.disposition?.replaceAll("_", " ") ?? "awaiting quorum"}
                        </p>
                        <p>{request.explanation}</p>
                        {request.approvals.length ? (
                          <ul className={styles.approvalList}>
                            {request.approvals.map((approval) => (
                              <li key={approval.id}>
                                <span>{approval.kind.replaceAll("_", " ")}</span>
                                <AdminBadge value="APPROVED" />
                                <small>{approval.approverRole} · {approval.approverId}<br />{approval.notes}</small>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {request.status === "PENDING" && canApproveAdjustmentEvidence ? (
                          <form action={approveAdjustmentEvidenceAction} className={styles.approvalForm}>
                            <input name="requestId" type="hidden" value={request.id} />
                            <input aria-label="Immutable adjustment evidence reference" name="evidenceRef" placeholder="Provider record, case file, or evidence URI" required minLength={5} maxLength={500} />
                            <textarea aria-label="Operations evidence review notes" name="notes" placeholder="Explain the amount, allocation, entrant, and evidence reviewed" required minLength={10} maxLength={1000} />
                            <button className={styles.operationButton} type="submit">Approve evidence record</button>
                          </form>
                        ) : null}
                        {request.status === "REVIEW" && evidenceApproval && !decisionApproval && canDecideAdjustment ? (
                          <form action={decideAdjustmentComplianceAction} className={styles.approvalForm}>
                            <input name="requestId" type="hidden" value={request.id} />
                            {hasDraw ? (
                              <label>Post-draw disposition
                                <select name="disposition" required defaultValue="">
                                  <option disabled value="">Select a controlled disposition</option>
                                  {isPositiveGrant ? (
                                    <option value="VOID_DRAW_AND_REBUILD">Void draw evidence and rebuild</option>
                                  ) : (
                                    <>
                                      <option value="PRESERVE_RESULT">Preserve historical draw result</option>
                                      <option value="DISQUALIFY_ENTRANT">Disqualify entrant under rules</option>
                                    </>
                                  )}
                                </select>
                              </label>
                            ) : <input name="disposition" type="hidden" value={isPositiveGrant ? "APPLY_BEFORE_DRAW" : "REVERSE_BEFORE_DRAW"} />}
                            <textarea aria-label="Compliance adjustment decision notes" name="notes" placeholder={hasDraw ? "Cite the rules and rationale for this post-draw disposition" : "Confirm reversal, snapshot voiding, and reconciliation rationale"} required minLength={10} maxLength={1000} />
                            <button className={styles.operationButton} type="submit">Record compliance decision</button>
                          </form>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
            <div className={styles.drawGrid}>
              <section className={styles.drawColumn}>
                <h3>Entry snapshots</h3>
                {campaign.snapshots.length ? (
                  <ul className={styles.recordList}>
                    {campaign.snapshots.map((snapshot) => (
                      <li className={styles.record} key={snapshot.id}>
                        <div className={styles.recordHead}><strong>Version {snapshot.version}</strong><AdminBadge value={snapshot.status} /></div>
                        <p>{formatEntries(snapshot.totalEntries)} entries · {snapshot.entrantCount} entrants · {snapshot._count.rows} range rows</p>
                        <p>Cutoff {formatDateTime(snapshot.cutoffAt, timezone)}<br />Checksum {fingerprint(snapshot.checksum)}<br />Sealed {snapshot.sealedAt ? `${formatDateTime(snapshot.sealedAt, timezone)} by ${snapshot.sealedBy ?? "unknown"}` : "not yet"}</p>
                        {snapshot.approvals.length ? (
                          <ul className={styles.approvalList}>
                            {snapshot.approvals.map((approval) => (
                              <li key={approval.id}>
                                <span>{approval.kind.replaceAll("_", " ")}</span>
                                <AdminBadge value={approval.status} />
                                {approval.approverId ? <small>{approval.approverId}</small> : null}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {snapshot.status === "AWAITING_APPROVAL" ? snapshot.approvals.map((approval) => {
                          const permitted = approval.status === "PENDING" && (
                            (approval.kind === "OPERATIONS_RECONCILIATION" && canOperate)
                            || (approval.kind === "COMPLIANCE_WITNESS" && canWitness)
                          );
                          return permitted ? (
                            <form action={approveSnapshotAction} className={styles.approvalForm} key={approval.id}>
                              <input name="snapshotId" type="hidden" value={snapshot.id} />
                              <input name="kind" type="hidden" value={approval.kind} />
                              <input aria-label={`${approval.kind} approval notes`} name="notes" placeholder="Reconciliation evidence and notes" required minLength={5} maxLength={500} />
                              <button className={styles.operationButton} type="submit">Approve {approval.kind === "COMPLIANCE_WITNESS" ? "as witness" : "reconciliation"}</button>
                            </form>
                          ) : null;
                        }) : null}
                        {data.demoMode && snapshot.status === "SEALED" && !campaign.draws.some((draw) => !["VOID", "CANCELLED"].includes(draw.status)) && snapshot.approvals.some((approval) => approval.kind === "OPERATIONS_RECONCILIATION" && approval.approverId === data.identity.id) ? (
                          <form action={conductDrawAction} className={styles.approvalForm}>
                            <input name="snapshotId" type="hidden" value={snapshot.id} />
                            <button className={styles.operationButton} disabled={Boolean(campaign.drawAt && campaign.drawAt > now)} type="submit">Conduct demo draw</button>
                          </form>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : <div className={styles.secondary}>No snapshot has been created.</div>}
              </section>
              <section className={styles.drawColumn}>
                <h3>Draw executions</h3>
                {campaign.draws.length ? (
                  <ul className={styles.recordList}>
                    {campaign.draws.map((draw) => (
                      <li className={styles.record} key={draw.id}>
                        <div className={styles.recordHead}><strong>{draw.provider}</strong><AdminBadge value={draw.status} /></div>
                        <p>{draw.algorithm} v{draw.algorithmVersion} · snapshot v{draw.snapshot.version}</p>
                        <p>Conducted {draw.conductedAt ? formatDateTime(draw.conductedAt, timezone) : "not yet"}<br />Operator {draw.operatorId ?? "—"} · witness {draw.witnessId ?? "—"}<br />Seed hash {fingerprint(draw.seedHash)}<br />Result {fingerprint(draw.resultChecksum)}</p>
                      </li>
                    ))}
                  </ul>
                ) : <div className={styles.secondary}>No draw execution exists.</div>}
              </section>
              <section className={styles.drawColumn}>
                <h3>Winner records</h3>
                {campaign.winners.length ? (
                  <ul className={styles.recordList}>
                    {campaign.winners.map((winner) => (
                      <li className={styles.record} key={winner.id}>
                        <div className={styles.recordHead}><strong>{winner.publicName ?? winner.entrant.name}</strong><AdminBadge value={winner.status} /></div>
                        <p>{winner.prize.name} · {formatMoney(winner.prize.approximateValueCents, winner.prize.currency)}<br />{winner.publicLocation ?? "Location withheld"}</p>
                        <p>Verified {winner.verifiedAt ? formatDateTime(winner.verifiedAt, timezone) : "not yet"}<br />Published {winner.publishedAt ? formatDateTime(winner.publishedAt, timezone) : "not yet"}<br />Fulfilled {winner.fulfilledAt ? formatDateTime(winner.fulfilledAt, timezone) : "not yet"}</p>
                        {winner.status === "VERIFIED" && canPublishWinner ? (
                          <form action={publishWinnerAction} className={styles.approvalForm}>
                            <input name="winnerId" type="hidden" value={winner.id} />
                            <input aria-label="Consented public winner name" name="publicName" placeholder="Consented public name" required minLength={2} maxLength={100} />
                            <input aria-label="Consented public winner location" name="publicLocation" placeholder="City, state or approved location" required minLength={2} maxLength={100} />
                            <input aria-label="Optional winner quote" name="quote" placeholder="Optional approved quote" maxLength={500} />
                            <label><input name="publicationConsentConfirmed" type="checkbox" required /> I verified the winner’s explicit publication consent and approved public fields.</label>
                            <button className={styles.operationButton} type="submit">Publish verified winner</button>
                          </form>
                        ) : null}
                        {winner.status === "PUBLISHED" && !winner.fulfilledAt && canRecordFulfillment ? (
                          <form action={recordWinnerFulfillmentAction} className={styles.approvalForm}>
                            <input name="winnerId" type="hidden" value={winner.id} />
                            <input aria-label="Fulfillment evidence reference" name="evidenceReference" placeholder="Immutable delivery/title evidence reference" required minLength={5} maxLength={500} />
                            <button className={styles.operationButton} type="submit">Record prize fulfillment</button>
                          </form>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : <div className={styles.secondary}>No winner has been attached.</div>}
              </section>
            </div>
            {campaign.draws.some((draw) => draw.candidates.length) && (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead><tr><th>Draw</th><th>Rank</th><th>Selected entry</th><th>Entrant</th><th>Status</th><th>Contact deadline</th><th>Verification</th><th>Winner</th><th>Controlled action</th></tr></thead>
                  <tbody>
                    {campaign.draws.flatMap((draw) => {
                      const currentCandidate = draw.candidates.find((item) => item.status !== "DISQUALIFIED");
                      return draw.candidates.map((candidate) => (
                      <tr key={candidate.id}>
                        <td><div className={styles.primaryCell}><strong>{draw.provider}</strong><span>{draw.id}</span></div></td>
                        <td className={styles.numeric}>#{candidate.rank}</td>
                        <td className={styles.numeric}>{formatEntries(candidate.selectedEntry)}</td>
                        <td><div className={styles.primaryCell}><strong>{candidate.entrant.name}</strong><span>{candidate.entrant.normalizedEmail}</span><span>{candidate.entrant.phone ?? "No verified phone on file"}</span></div></td>
                        <td><AdminBadge value={candidate.status} /></td>
                        <td className={styles.numeric}>{candidate.contactDeadline ? formatDateTime(candidate.contactDeadline, timezone) : "—"}</td>
                        <td className={styles.numeric}>{candidate.verifiedAt ? formatDateTime(candidate.verifiedAt, timezone) : candidate.decisionReason ?? "Pending"}</td>
                        <td>{candidate.winner ? <AdminBadge value={candidate.winner.status} /> : <span className={styles.secondary}>Not attached</span>}</td>
                        <td>
                          {currentCandidate?.id === candidate.id && ["CONTACTING", "ALTERNATE"].includes(candidate.status) ? (
                            <details className={styles.operationDetails}>
                              <summary>Review</summary>
                              <div className={styles.stack}>
                                {canManageContact ? (
                                  <form action={recordCandidateContactAction} className={styles.approvalForm}>
                                    <input name="candidateId" type="hidden" value={candidate.id} />
                                    <label>Contact deadline (ISO 8601 with offset)<input name="contactDeadline" type="text" placeholder="2026-08-01T17:00:00-04:00" required pattern={"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2})?(Z|[+-]\\d{2}:\\d{2})$"} /></label>
                                    <button className={styles.operationButton} type="submit">Record contact</button>
                                  </form>
                                ) : null}
                                {canDecideCandidate && candidate.status === "CONTACTING" ? (
                                  <>
                                    <form action={decideCandidateAction} className={styles.approvalForm}>
                                      <input name="candidateId" type="hidden" value={candidate.id} />
                                      <input name="decision" type="hidden" value="VERIFY" />
                                      <textarea aria-label="Candidate verification evidence" name="reason" placeholder="Eligibility and identity evidence summary" required minLength={10} maxLength={1000} />
                                      <button className={styles.operationButton} type="submit">Verify candidate</button>
                                    </form>
                                    <form action={decideCandidateAction} className={styles.approvalForm}>
                                      <input name="candidateId" type="hidden" value={candidate.id} />
                                      <input name="decision" type="hidden" value="DISQUALIFY" />
                                      <textarea aria-label="Candidate disqualification rationale" name="reason" placeholder="Rules-based disqualification rationale" required minLength={10} maxLength={1000} />
                                      <button className={styles.operationButton} type="submit">Disqualify and advance</button>
                                    </form>
                                  </>
                                ) : null}
                              </div>
                            </details>
                          ) : <span className={styles.secondary}>—</span>}
                        </td>
                      </tr>
                    ));
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </article>
        ))}
      </div>
    </>
  );
}

function Metric({ label, value, meta }: { label: string; value: string; meta: string }) {
  return <div className={styles.metric}><span className={styles.metricLabel}>{label}</span><strong className={styles.metricValue}>{value}</strong><span className={styles.metricMeta}>{meta}</span></div>;
}
