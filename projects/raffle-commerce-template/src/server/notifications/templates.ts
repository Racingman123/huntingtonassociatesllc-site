import "server-only";

import { formatDateTime, formatEntries, formatMoney } from "@/lib/format";
import { db } from "@/server/db";
import { assertCampaignOfficialRules, officialRulesHref } from "@/lib/official-rules";
import { canonicalSiteUrl } from "@/server/site-url";
import { reconstructAccountChallengeToken } from "@/server/auth/challenges";
import { NotificationDeliveryError, type TransactionalEmail } from "./email";

export const EMAIL_OUTBOX_KINDS = [
  "ORDER_CONFIRMATION_EMAIL",
  "FREE_ENTRY_RECEIPT",
  "FREE_ENTRY_REVIEWED_NOTIFICATION",
  "SUPPORT_ACKNOWLEDGMENT_EMAIL",
  "SUBSCRIPTION_CREATED_NOTIFICATION",
  "SUBSCRIPTION_RENEWAL_RECEIPT",
  "SUBSCRIPTION_CANCELLATION_SCHEDULED",
  "SUBSCRIPTION_CANCELLED",
  "REFUND_SETTLED_NOTIFICATION",
  "ACCOUNT_EMAIL_VERIFICATION",
  "ACCOUNT_PASSWORD_RECOVERY",
] as const;

export type EmailOutboxKind = (typeof EMAIL_OUTBOX_KINDS)[number];

export type EmailOutboxReference = {
  id: string;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  kind: string;
};

const expectedAggregateType: Record<EmailOutboxKind, string> = {
  ORDER_CONFIRMATION_EMAIL: "Order",
  FREE_ENTRY_RECEIPT: "FreeEntrySubmission",
  FREE_ENTRY_REVIEWED_NOTIFICATION: "FreeEntrySubmission",
  SUPPORT_ACKNOWLEDGMENT_EMAIL: "SupportTicket",
  SUBSCRIPTION_CREATED_NOTIFICATION: "Subscription",
  SUBSCRIPTION_RENEWAL_RECEIPT: "SubscriptionCycle",
  SUBSCRIPTION_CANCELLATION_SCHEDULED: "Subscription",
  SUBSCRIPTION_CANCELLED: "Subscription",
  REFUND_SETTLED_NOTIFICATION: "Refund",
  ACCOUNT_EMAIL_VERIFICATION: "AccountChallenge",
  ACCOUNT_PASSWORD_RECOVERY: "AccountChallenge",
};

function templateFailure(code: string): never {
  throw new NotificationDeliveryError(code, false);
}

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function textValue(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function templateVersion(kind: EmailOutboxKind) {
  return `${kind.toLowerCase()}_v1`;
}

function message(input: {
  tenant: { displayName: string; supportEmail: string; primaryDomain: string | null };
  to: string;
  kind: EmailOutboxKind;
  subject: string;
  heading: string;
  intro: string;
  rows: Array<[string, string]>;
  action?: { label: string; path: string };
}): TransactionalEmail {
  const displayName = textValue(input.tenant.displayName);
  const supportEmail = textValue(input.tenant.supportEmail);
  const rowsHtml = input.rows.map(([label, value]) => (
    `<tr><th align="left" style="padding:8px 12px 8px 0;color:#555;font-weight:600">${escapeHtml(label)}</th>`
    + `<td style="padding:8px 0;color:#111">${escapeHtml(value)}</td></tr>`
  )).join("");
  const actionUrl = input.action
    ? new URL(input.action.path, canonicalSiteUrl(input.tenant)).toString()
    : null;
  const actionHtml = actionUrl && input.action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(actionUrl)}" style="background:#111;color:#fff;padding:12px 18px;text-decoration:none;border-radius:4px">${escapeHtml(input.action.label)}</a></p>`
    : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f5;font-family:Arial,sans-serif;color:#111"><div style="max-width:620px;margin:0 auto;padding:32px 20px"><div style="background:#fff;padding:32px;border-radius:8px"><p style="margin:0 0 8px;color:#666;font-size:13px;text-transform:uppercase;letter-spacing:.08em">${escapeHtml(displayName)}</p><h1 style="margin:0 0 16px;font-size:26px">${escapeHtml(input.heading)}</h1><p style="line-height:1.6">${escapeHtml(input.intro)}</p><table role="presentation" style="border-collapse:collapse;margin:20px 0">${rowsHtml}</table>${actionHtml}<p style="margin:24px 0 0;color:#666;font-size:13px;line-height:1.5">Questions? Reply to this email or contact ${escapeHtml(supportEmail)}. Never send passwords, payment-card details, or government identification by email.</p></div></div></body></html>`;
  const rowsText = input.rows.map(([label, value]) => `${label}: ${value}`).join("\n");
  const actionText = actionUrl && input.action ? `\n${input.action.label}: ${actionUrl}\n` : "";
  const text = `${displayName}\n\n${textValue(input.heading)}\n\n${textValue(input.intro)}\n\n${rowsText}${actionText}\nQuestions? Reply to this email or contact ${supportEmail}. Never send passwords, payment-card details, or government identification by email.`;
  return {
    to: input.to,
    subject: input.subject,
    html,
    text,
    replyTo: input.tenant.supportEmail,
    templateVersion: templateVersion(input.kind),
  };
}

function assertReference(event: EmailOutboxReference): EmailOutboxKind {
  if (!EMAIL_OUTBOX_KINDS.includes(event.kind as EmailOutboxKind)) {
    return templateFailure("notification_kind_unsupported");
  }
  const kind = event.kind as EmailOutboxKind;
  if (event.aggregateType !== expectedAggregateType[kind]) {
    return templateFailure("notification_aggregate_type_mismatch");
  }
  return kind;
}

async function orderConfirmation(event: EmailOutboxReference, kind: EmailOutboxKind) {
  const order = await db.order.findFirst({
    where: { id: event.aggregateId, tenantId: event.tenantId },
    include: { tenant: true, lines: { select: { productTitle: true, quantity: true } } },
  });
  if (!order) return templateFailure("notification_aggregate_not_found");
  return message({
    tenant: order.tenant,
    to: order.email,
    kind,
    subject: `${order.tenant.displayName} order ${order.orderNumber}`,
    heading: "Your order is confirmed",
    intro: `Thanks, ${textValue(order.customerName)}. We recorded your order and its promotional entries.`,
    rows: [
      ["Order", order.orderNumber],
      ["Items", order.lines.map((line) => `${line.quantity} × ${line.productTitle}`).join(", ")],
      ["Total", formatMoney(order.totalCents, order.currency)],
      ["Entries", formatEntries(order.entryTotal)],
    ],
    action: { label: "View your account", path: "/account" },
  });
}

async function freeEntryMessage(event: EmailOutboxReference, kind: EmailOutboxKind) {
  const submission = await db.freeEntrySubmission.findFirst({
    where: { id: event.aggregateId, tenantId: event.tenantId },
    include: {
      tenant: true,
      campaign: { include: { officialRulesDocument: true } },
      entrant: true,
      entitlement: true,
    },
  });
  if (!submission) return templateFailure("notification_aggregate_not_found");
  const reviewed = kind === "FREE_ENTRY_REVIEWED_NOTIFICATION";
  if (reviewed && !["APPROVED", "REJECTED"].includes(submission.status)) {
    return templateFailure("notification_aggregate_state_invalid");
  }
  const displayedEntries = reviewed && submission.status === "APPROVED"
    ? submission.entitlement?.originalEntries ?? submission.entriesRequested
    : submission.entriesRequested;
  const outcome = reviewed
    ? submission.status === "APPROVED" ? "Approved" : "Not approved"
    : "Received";
  const heading = reviewed
    ? submission.status === "APPROVED" ? "Your free entry was approved" : "Your free-entry review is complete"
    : "We received your free entry";
  const intro = reviewed && submission.status === "REJECTED"
    ? "This submission was not approved. Contact support with the reference below if you believe this needs review."
    : reviewed
      ? "Your approved entries are now recorded in the same drawing pool as every other eligible entry."
      : "No purchase or marketing consent was required. Keep this confirmation for your records.";
  return message({
    tenant: submission.tenant,
    to: submission.entrant.normalizedEmail,
    kind,
    subject: `${submission.tenant.displayName} free-entry ${reviewed ? "review" : "receipt"}`,
    heading,
    intro,
    rows: [
      ["Promotion", submission.campaign.title],
      ["Confirmation", submission.confirmationCode],
      ["Status", outcome],
      [reviewed && submission.status === "APPROVED" ? "Entries awarded" : "Entries requested", formatEntries(displayedEntries)],
    ],
    action: {
      label: "Read the Official Rules",
      path: officialRulesHref(assertCampaignOfficialRules(submission.campaign)),
    },
  });
}

async function supportAcknowledgment(event: EmailOutboxReference, kind: EmailOutboxKind) {
  const ticket = await db.supportTicket.findFirst({
    where: { id: event.aggregateId, tenantId: event.tenantId },
    include: { tenant: true },
  });
  if (!ticket) return templateFailure("notification_aggregate_not_found");
  return message({
    tenant: ticket.tenant,
    to: ticket.email,
    kind,
    subject: `${ticket.tenant.displayName} support request received`,
    heading: "We received your support request",
    intro: `Thanks, ${textValue(ticket.name)}. Our support team will review your request.`,
    rows: [
      ["Reference", ticket.id.slice(-8).toUpperCase()],
      ["Subject", textValue(ticket.subject)],
      ["Received", formatDateTime(ticket.createdAt, ticket.tenant.timezone)],
    ],
  });
}

async function subscriptionMessage(event: EmailOutboxReference, kind: EmailOutboxKind) {
  const subscription = await db.subscription.findFirst({
    where: { id: event.aggregateId, tenantId: event.tenantId },
    include: { tenant: true, plan: true, entrant: true },
  });
  if (!subscription) return templateFailure("notification_aggregate_not_found");
  if (kind === "SUBSCRIPTION_CREATED_NOTIFICATION") {
    return message({
      tenant: subscription.tenant,
      to: subscription.entrant.normalizedEmail,
      kind,
      subject: `${subscription.tenant.displayName} membership confirmed`,
      heading: "Your membership is active",
      intro: "Your membership enrollment is recorded. Future entries post only after each successful renewal.",
      rows: [
        ["Plan", subscription.plan.name],
        ["Price", formatMoney(subscription.plan.priceCents, subscription.plan.currency)],
        ["Enrolled", formatDateTime(subscription.createdAt, subscription.tenant.timezone)],
      ],
      action: { label: "Manage membership", path: "/account/membership" },
    });
  }
  // A scheduled-cancellation email can be retried after the subscription has
  // already reached its terminal state. Render current authoritative state.
  if (
    kind === "SUBSCRIPTION_CANCELLATION_SCHEDULED"
    && subscription.status !== "CANCELLED"
    && !subscription.cancelAtPeriodEnd
  ) {
    return null;
  }
  const cancelled = kind === "SUBSCRIPTION_CANCELLED" || subscription.status === "CANCELLED";
  return message({
    tenant: subscription.tenant,
    to: subscription.entrant.normalizedEmail,
    kind,
    subject: `${subscription.tenant.displayName} membership cancellation`,
    heading: cancelled ? "Your membership is cancelled" : "Cancellation is scheduled",
    intro: cancelled
      ? "Your membership will not renew again. This does not retroactively change previously settled benefits."
      : "Your membership remains active through the end of the current paid period and will not renew afterward.",
    rows: [
      ["Plan", subscription.plan.name],
      [cancelled ? "Cancelled" : "Effective", formatDateTime(
        subscription.cancelledAt ?? subscription.currentPeriodEndsAt,
        subscription.tenant.timezone,
      )],
    ],
    action: { label: "View membership", path: "/account/membership" },
  });
}

async function accountChallengeMessage(event: EmailOutboxReference, kind: EmailOutboxKind) {
  const challenge = await db.accountChallenge.findFirst({
    where: { id: event.aggregateId, tenantId: event.tenantId },
    include: { tenant: true, user: true },
  });
  if (!challenge) return templateFailure("notification_aggregate_not_found");
  if (challenge.consumedAt || challenge.expiresAt <= new Date()) return null;
  const expectedPurpose = kind === "ACCOUNT_EMAIL_VERIFICATION" ? "VERIFY_EMAIL" : "RESET_PASSWORD";
  if (challenge.purpose !== expectedPurpose) {
    return templateFailure("notification_aggregate_state_invalid");
  }
  const token = reconstructAccountChallengeToken(challenge);
  const path = kind === "ACCOUNT_EMAIL_VERIFICATION"
    ? `/verify-email?token=${encodeURIComponent(token)}`
    : `/reset-password?token=${encodeURIComponent(token)}`;
  const verifying = kind === "ACCOUNT_EMAIL_VERIFICATION";
  return message({
    tenant: challenge.tenant,
    to: challenge.user.email,
    kind,
    subject: `${challenge.tenant.displayName} ${verifying ? "verify your email" : "password reset"}`,
    heading: verifying ? "Verify your email address" : "Reset your password",
    intro: verifying
      ? "Confirm this address to connect the account with any prior guest orders, memberships, and promotional entries that can be claimed safely."
      : "Use this single-use link to choose a new password. If you did not request it, you can ignore this message.",
    rows: [["Link expires", formatDateTime(challenge.expiresAt, challenge.tenant.timezone)]],
    action: { label: verifying ? "Verify email" : "Reset password", path },
  });
}

async function renewalReceipt(event: EmailOutboxReference, kind: EmailOutboxKind) {
  const cycle = await db.subscriptionCycle.findFirst({
    where: { id: event.aggregateId, subscription: { tenantId: event.tenantId } },
    include: {
      subscription: { include: { tenant: true, plan: true } },
      order: true,
      adjustmentRequest: { select: { status: true, delta: true } },
    },
  });
  if (!cycle) return templateFailure("notification_aggregate_not_found");
  return message({
    tenant: cycle.subscription.tenant,
    to: cycle.order.email,
    kind,
    subject: `${cycle.subscription.tenant.displayName} renewal receipt`,
    heading: "Your membership renewed",
    intro: cycle.adjustmentRequest
      ? "We recorded your paid renewal. Its promotional-entry grant is in controlled reconciliation because the campaign population had already frozen."
      : cycle.order.entryTotal > 0n
        ? "We recorded this renewal and posted its eligible promotional entries."
        : "We recorded this renewal. No promotional entries were available for this billing cycle.",
    rows: [
      ["Plan", cycle.subscription.plan.name],
      ["Order", cycle.order.orderNumber],
      ["Total", formatMoney(cycle.order.totalCents, cycle.order.currency)],
      ["Entries", formatEntries(cycle.order.entryTotal)],
      ...(cycle.adjustmentRequest ? [["Entries under review", formatEntries(cycle.adjustmentRequest.delta)] as [string, string]] : []),
      ["Period ends", formatDateTime(cycle.periodEndsAt, cycle.subscription.tenant.timezone)],
    ],
    action: { label: "View your account", path: "/account" },
  });
}

async function refundNotice(event: EmailOutboxReference, kind: EmailOutboxKind) {
  const refund = await db.refund.findFirst({
    where: { id: event.aggregateId, tenantId: event.tenantId },
    include: {
      tenant: true,
      order: true,
      allocations: true,
      adjustmentRequest: { select: { status: true, disposition: true } },
    },
  });
  if (!refund) return templateFailure("notification_aggregate_not_found");
  const entriesReversed = refund.allocations.reduce((sum, item) => sum + item.entriesReversed, 0n);
  const entryConsequence: [string, string] = !refund.adjustmentRequest
    ? ["Entries reversed", formatEntries(entriesReversed)]
    : refund.adjustmentRequest.status === "APPLIED"
      ? ["Entries reversed", formatEntries(entriesReversed)]
      : refund.adjustmentRequest.disposition === "PRESERVE_RESULT"
        ? ["Entry consequence", "Historical draw result preserved"]
        : refund.adjustmentRequest.disposition === "DISQUALIFY_ENTRANT"
          ? ["Entry consequence", "Eligibility disposition recorded"]
          : ["Entry consequence", "Under controlled review"];
  return message({
    tenant: refund.tenant,
    to: refund.order.email,
    kind,
    subject: `${refund.tenant.displayName} refund notice`,
    heading: "Your refund was recorded",
    intro: refund.adjustmentRequest
      ? "Your monetary refund is complete. Any frozen promotional-entry consequence follows a separate controlled review."
      : "The refundable merchandise amount and its attributable promotional entries were adjusted together.",
    rows: [
      ["Order", refund.order.orderNumber],
      ["Refund", formatMoney(refund.amountCents, refund.currency)],
      entryConsequence,
      ["Status", refund.status === "COMPLETED" ? "Completed" : textValue(refund.status)],
    ],
    action: { label: "View your account", path: "/account" },
  });
}

/** Builds from the tenant-scoped aggregate id; payloadJson is never an identity source. */
export async function buildTransactionalEmail(event: EmailOutboxReference) {
  const kind = assertReference(event);
  switch (kind) {
    case "ORDER_CONFIRMATION_EMAIL":
      return orderConfirmation(event, kind);
    case "FREE_ENTRY_RECEIPT":
    case "FREE_ENTRY_REVIEWED_NOTIFICATION":
      return freeEntryMessage(event, kind);
    case "SUPPORT_ACKNOWLEDGMENT_EMAIL":
      return supportAcknowledgment(event, kind);
    case "SUBSCRIPTION_CREATED_NOTIFICATION":
    case "SUBSCRIPTION_CANCELLATION_SCHEDULED":
    case "SUBSCRIPTION_CANCELLED":
      return subscriptionMessage(event, kind);
    case "SUBSCRIPTION_RENEWAL_RECEIPT":
      return renewalReceipt(event, kind);
    case "REFUND_SETTLED_NOTIFICATION":
      return refundNotice(event, kind);
    case "ACCOUNT_EMAIL_VERIFICATION":
    case "ACCOUNT_PASSWORD_RECOVERY":
      return accountChallengeMessage(event, kind);
  }
}
