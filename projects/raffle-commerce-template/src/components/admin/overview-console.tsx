import { formatDateTime, formatEntries, formatMoney } from "@/lib/format";
import type { getAdminOverview } from "@/server/admin/dal";
import { AdminBadge } from "./admin-badge";
import { AdminPageHeader } from "./admin-page-header";
import styles from "./admin.module.css";

type OverviewData = Awaited<ReturnType<typeof getAdminOverview>>;

export function OverviewConsole({ data }: { data: OverviewData }) {
  const timezone = data.identity.tenant.timezone;
  return (
    <>
      <AdminPageHeader
        eyebrow="Promotion operations"
        title="Control room"
        description="Live campaign posture, compliance evidence, entry liabilities, and launch integration readiness—read directly from the operational database."
        meta={<>As of {formatDateTime(new Date(), timezone)}<br />All times shown in {timezone}</>}
      />
      <section className={styles.metrics} aria-label="Operations metrics">
        <Metric label="Orders" value={String(data.metrics.orderCount)} meta="All payment states" />
        <Metric label="Captured revenue" value={formatMoney(data.metrics.capturedRevenueCents, data.identity.tenant.currency)} meta="Captured / paid only" />
        <Metric label="Entrants" value={String(data.metrics.entrantCount)} meta="Tenant-wide identities" />
        <Metric label="Entry liability" value={formatEntries(data.metrics.activeEntries)} meta="Current account balances" />
        <Metric label="AMOE review" value={String(data.metrics.pendingAmoe)} meta="Pending or in review" />
        <Metric label="Open support" value={String(data.metrics.openTickets)} meta="Open or pending" />
      </section>

      <div className={styles.gridTwo}>
        <div className={styles.stack}>
          {data.campaigns.map((campaign) => (
            <article className={styles.campaignCard} key={campaign.id}>
              <div className={styles.campaignHead}>
                <div>
                  <span className={styles.campaignCode}>{campaign.code} · {campaign.status}</span>
                  <h2>{campaign.title}</h2>
                  <div className={styles.campaignMeta}>
                    <span>Opens {formatDateTime(campaign.startsAt, timezone)}</span>
                    <span>Closes {formatDateTime(campaign.endsAt, timezone)}</span>
                    <span>Draw {campaign.drawAt ? formatDateTime(campaign.drawAt, timezone) : "Not scheduled"}</span>
                  </div>
                </div>
                <AdminBadge value={campaign.lifecycle} />
              </div>
              <div className={styles.campaignStats}>
                <CampaignStat label="Checks passed" value={`${campaign.passCount}/${campaign.checks.length}`} />
                <CampaignStat label="Entry accounts" value={String(campaign.counts.accounts)} />
                <CampaignStat label="Orders" value={String(campaign.counts.orders)} />
                <CampaignStat label="Free entries" value={String(campaign.counts.freeEntries)} />
                <CampaignStat label="Prize ARV" value={formatMoney(campaign.prizeValueCents, data.identity.tenant.currency)} />
              </div>
              <ul className={styles.checklist} aria-label={`${campaign.code} compliance checklist`}>
                {campaign.checks.map((check) => (
                  <li className={styles.checkItem} key={check.key}>
                    <span className={styles.checkIcon} data-status={check.status} aria-label={check.status}>
                      {check.status === "PASS" ? "✓" : check.status === "WARN" ? "!" : "×"}
                    </span>
                    <div className={styles.checkCopy}>
                      <strong>{check.label}</strong>
                      <span>{check.detail}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </article>
          ))}
          {!data.campaigns.length && (
            <section className={styles.panel}><div className={styles.empty}><strong>No campaigns configured</strong>Create and approve a campaign before launch.</div></section>
          )}
        </div>

        <aside className={styles.stack}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div><h2>Integration readiness</h2><p>Configuration presence only; never exposes secrets</p></div>
              <AdminBadge value={data.integrations.ready ? "READY" : data.integrations.demoMode ? "DEMO" : "ACTION_REQUIRED"} />
            </div>
            <ul className={styles.readinessList}>
              {data.integrations.checks.map((check) => (
                <li className={styles.readinessItem} key={check.key}>
                  <div><strong>{check.label}</strong><p>{check.detail}</p></div>
                  <AdminBadge value={check.status} />
                </li>
              ))}
            </ul>
          </section>
          <div className={styles.notice}>
            Operational mutations are separated by role. AMOE review, snapshot approval, drawing, winner verification, support status changes, refunds, and configuration publication record explicit evidence or reason codes in the immutable audit trail.
          </div>
        </aside>
      </div>
    </>
  );
}

function Metric({ label, value, meta }: { label: string; value: string; meta: string }) {
  return <div className={styles.metric}><span className={styles.metricLabel}>{label}</span><strong className={styles.metricValue}>{value}</strong><span className={styles.metricMeta}>{meta}</span></div>;
}

function CampaignStat({ label, value }: { label: string; value: string }) {
  return <div className={styles.campaignStat}><span>{label}</span><strong>{value}</strong></div>;
}
