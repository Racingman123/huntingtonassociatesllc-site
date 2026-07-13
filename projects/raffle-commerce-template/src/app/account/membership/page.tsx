import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { cancelMembershipAction } from "@/app/membership/actions";
import { AccountPageHeader } from "@/components/account/page-header";
import { StatusPill } from "@/components/account/status-pill";
import { formatDateTime, formatEntries, formatMoney } from "@/lib/format";
import { getAccountMemberships } from "@/server/subscriptions/dal";
import styles from "@/components/account/account.module.css";

export const metadata: Metadata = { title: "Membership" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AccountMembershipPage({ searchParams }: { searchParams: SearchParams }) {
  const [{ viewer, subscriptions }, query] = await Promise.all([getAccountMemberships(), searchParams]);
  const started = query.started === "1";
  const processing = query.checkout === "processing";
  const cancelled = query.cancelled === "1";
  const hasError = typeof query.error === "string";

  return (
    <>
      <AccountPageHeader
        kicker="Recurring products"
        title="Membership"
        description="Review billing periods, entry awards, and period-end cancellation status."
      />

      {started ? <p className={styles.formResult}>Membership started. Your first captured cycle and any eligible entries are recorded below.</p> : null}
      {processing ? <p className={styles.formResult}>Stripe is confirming your membership. A paid cycle appears only after the signed invoice event settles.</p> : null}
      {cancelled ? <p className={styles.formResult}>Cancellation is scheduled for the end of the current paid period.</p> : null}
      {hasError ? <p className={styles.formResult} data-status="error">We could not complete that membership request. No extra charge was recorded.</p> : null}

      <div className={styles.stack} style={{ marginTop: started || processing || cancelled || hasError ? 18 : 0 }}>
        {subscriptions.length ? subscriptions.map((subscription) => (
          <section className={styles.panel} key={subscription.id}>
            <div className={styles.panelHeader}>
              <div>
                <h2>{subscription.plan.name}</h2>
                <p className={styles.settingsCopy}>{formatMoney(subscription.plan.priceCents, subscription.plan.currency)} every {subscription.plan.intervalCount > 1 ? `${subscription.plan.intervalCount} ` : ""}{subscription.plan.interval.toLowerCase()}</p>
              </div>
              <StatusPill value={subscription.status} />
            </div>
            <div className={styles.membershipSummary}>
              <div><span>Current period</span><strong>{formatDateTime(subscription.currentPeriodStartsAt, viewer.tenant.timezone)}</strong></div>
              <div><span>Renews or ends</span><strong>{formatDateTime(subscription.currentPeriodEndsAt, viewer.tenant.timezone)}</strong></div>
              <div><span>Paid cycles</span><strong>{subscription.settledCycleCount}</strong></div>
              <div><span>Renewal status</span><strong>{subscription.cancelAtPeriodEnd ? "Ends this period" : "Continues"}</strong></div>
            </div>

            {subscription.cycles.length ? (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead><tr><th>Cycle</th><th>Order</th><th>Captured</th><th>Entries</th><th>Status</th></tr></thead>
                  <tbody>
                    {subscription.cycles.map((cycle) => (
                      <tr key={cycle.id}>
                        <td className={styles.numeric}>#{cycle.cycleNumber}</td>
                        <td><Link className={styles.tableLink} href={`/account/orders/${cycle.order.orderNumber}`}>{cycle.order.orderNumber}</Link></td>
                        <td className={styles.numeric}>{cycle.order.paidAt ? formatDateTime(cycle.order.paidAt, viewer.tenant.timezone) : "—"}</td>
                        <td className={`${styles.numeric} ${styles.positive}`}>+{formatEntries(cycle.order.entryTotal)}</td>
                        <td><StatusPill value={cycle.order.paymentStatus} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className={styles.empty}><div><strong>No captured cycles</strong>A provider capture must settle before a cycle or entry grant appears.</div></div>}

            <div className={styles.membershipActions}>
              <p className={styles.settingsCopy}>Cancellation stops future renewals after the current paid period. It does not erase recorded orders, benefits, or ledger history.</p>
              {(
                subscription.provider === "STRIPE"
                  ? Boolean(subscription.providerCustomerId)
                    && ["PENDING", "ACTIVE", "PAST_DUE"].includes(subscription.status)
                  : !subscription.cancelAtPeriodEnd && ["ACTIVE", "PAST_DUE"].includes(subscription.status)
              ) ? (
                <form action={cancelMembershipAction}>
                  <input name="subscriptionId" type="hidden" value={subscription.id} />
                  <input name="idempotencyKey" type="hidden" value={`cancel:${randomUUID()}`} />
                  <button className={`${styles.formButton} ${styles.secondaryButton}`} type="submit">{subscription.provider === "STRIPE" ? "Manage billing in Stripe" : "Cancel at period end"}</button>
                </form>
              ) : null}
            </div>
          </section>
        )) : (
          <section className={styles.panel}>
            <div className={styles.empty}><div><strong>No memberships yet</strong><Link className={styles.panelLink} href="/membership">Explore membership</Link></div></div>
          </section>
        )}
      </div>
    </>
  );
}
