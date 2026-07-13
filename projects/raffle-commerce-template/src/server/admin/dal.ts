import "server-only";

import { createHash } from "node:crypto";
import { cache } from "react";
import { db } from "@/server/db";
import { requireStaff, requireStaffRole } from "@/server/auth/dal";
import { getDeploymentReadiness } from "@/server/readiness";
import { campaignEligibilityOptions } from "@/server/campaigns/eligibility";

function checksum(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function integrationReadiness() {
  return getDeploymentReadiness();
}

function submittedContactPhone(value: string) {
  try {
    const phone = (JSON.parse(value) as { contactPhone?: unknown }).contactPhone;
    return typeof phone === "string" && /^\+?\d{7,20}$/.test(phone) ? phone : null;
  } catch {
    return null;
  }
}

export const getAdminIdentity = cache(async () => {
  const viewer = await requireStaff();
  return {
    id: viewer.userId,
    name: viewer.name,
    email: viewer.email,
    role: viewer.role,
    tenantId: viewer.tenantId,
    tenant: viewer.tenant,
  };
});

export const getAdminOverview = cache(async () => {
  const viewer = await requireStaff();
  const now = new Date();

  const [
    campaigns,
    publishedTheme,
    publicationAudits,
    revenue,
    orderCount,
    entrantCount,
    entryBalance,
    pendingAmoe,
    openTickets,
  ] = await Promise.all([
    db.campaign.findMany({
      where: { tenantId: viewer.tenantId },
      include: {
        prizes: { orderBy: { sortOrder: "asc" } },
        entryRules: { orderBy: { stackPriority: "asc" } },
        multiplierSlots: { orderBy: { startsAt: "desc" } },
        officialRulesDocument: true,
        snapshots: {
          select: {
            id: true,
            version: true,
            status: true,
            totalEntries: true,
            entrantCount: true,
            sealedAt: true,
          },
          orderBy: { version: "desc" },
          take: 1,
        },
        draws: {
          select: { id: true, status: true, conductedAt: true, provider: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        _count: {
          select: {
            orders: true,
            freeEntries: true,
            accounts: true,
            winners: true,
            acceptances: true,
          },
        },
      },
      orderBy: { startsAt: "desc" },
    }),
    db.themeVersion.findFirst({
      where: { tenantId: viewer.tenantId, status: "PUBLISHED" },
      select: { id: true, version: true, checksum: true, publishedAt: true },
      orderBy: { version: "desc" },
    }),
    db.auditEvent.findMany({
      where: {
        tenantId: viewer.tenantId,
        action: "CAMPAIGN_PUBLISHED",
        resourceType: "Campaign",
      },
      select: { resourceId: true },
    }),
    db.order.aggregate({
      where: {
        tenantId: viewer.tenantId,
        paymentStatus: { in: ["CAPTURED", "PAID"] },
      },
      _sum: { totalCents: true },
    }),
    db.order.count({ where: { tenantId: viewer.tenantId } }),
    db.entrant.count({ where: { tenantId: viewer.tenantId } }),
    db.entryAccount.aggregate({
      where: { tenantId: viewer.tenantId },
      _sum: { balance: true },
    }),
    db.freeEntrySubmission.count({
      where: { tenantId: viewer.tenantId, status: { in: ["PENDING", "REVIEW"] } },
    }),
    db.supportTicket.count({
      where: { tenantId: viewer.tenantId, status: { in: ["OPEN", "PENDING"] } },
    }),
  ]);

  const publishedCampaignIds = new Set(publicationAudits.map((event) => event.resourceId));

  const campaignOperations = campaigns.map((campaign) => {
    const latestSnapshot = campaign.snapshots[0] ?? null;
    const latestDraw = campaign.draws[0] ?? null;
    const hasAmoeRule = campaign.entryRules.some(
      (rule) => rule.active && (rule.ruleType === "AMOE_FIXED" || rule.targetType === "FREE_ENTRY"),
    );
    let eligibilityConfigurationValid = campaign.minimumAge >= 18;
    let eligibleCountryCount = 0;
    try {
      const eligibility = campaignEligibilityOptions(campaign);
      eligibleCountryCount = eligibility.countries.length;
      eligibilityConfigurationValid = eligibilityConfigurationValid && eligibleCountryCount > 0;
    } catch {
      eligibilityConfigurationValid = false;
    }
    const orderedMultiplierSlots = [...campaign.multiplierSlots].sort(
      (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
    );
    const multiplierScheduleValid = orderedMultiplierSlots.length === 0
      ? Number.isSafeInteger(campaign.currentMultiplier) && campaign.currentMultiplier > 0
      : orderedMultiplierSlots.every((slot, index) => (
        slot.numerator > 0
        && slot.denominator > 0
        && slot.numerator % slot.denominator === 0
        && slot.startsAt < slot.endsAt
        && (index === 0
          ? slot.startsAt <= campaign.startsAt
          : slot.startsAt.getTime() === orderedMultiplierSlots[index - 1]!.endsAt.getTime())
      )) && orderedMultiplierSlots.at(-1)!.endsAt >= campaign.endsAt;
    const liveCampaignCount = campaigns.filter((item) => item.status === "LIVE").length;
    const checks = [
      {
        key: "tenant-live-campaign",
        label: "Unambiguous storefront campaign",
        status: liveCampaignCount <= 1 ? "PASS" : "FAIL",
        detail: liveCampaignCount <= 1
          ? "At most one campaign is marked LIVE for this tenant."
          : `${liveCampaignCount} campaigns are LIVE; checkout fails closed until one remains.`,
      },
      {
        key: "eligibility-config",
        label: "Structured eligibility configuration",
        status: eligibilityConfigurationValid ? "PASS" : "FAIL",
        detail: eligibilityConfigurationValid
          ? `${eligibleCountryCount} eligible country code(s); minimum age ${campaign.minimumAge}.`
          : "Fix malformed country/region codes or the minimum-age configuration.",
      },
      {
        key: "multiplier-schedule",
        label: "Continuous multiplier schedule",
        status: multiplierScheduleValid ? "PASS" : "FAIL",
        detail: multiplierScheduleValid
          ? orderedMultiplierSlots.length
            ? `${orderedMultiplierSlots.length} integral period(s) continuously cover purchase entry.`
            : "The positive campaign fallback multiplier is in use."
          : "Multiplier periods must be integral, non-overlapping, contiguous, and cover purchase entry.",
      },
      {
        key: "approval",
        label: "Sponsor approval recorded",
        status: campaign.approvedAt ? "PASS" : "FAIL",
        detail: campaign.approvedAt
          ? "Approval timestamp is present."
          : "Campaign cannot launch without recorded approval.",
      },
      {
        key: "rules",
        label: "Exact Official Rules bound",
        status: campaign.officialRulesDocument
          && campaign.officialRulesDocumentId === campaign.officialRulesDocument.id
          && campaign.officialRulesChecksum === campaign.officialRulesDocument.checksum
          && campaign.officialRulesDocument.kind === "OFFICIAL_RULES"
          && campaign.officialRulesDocument.status === "PUBLISHED"
          && campaign.officialRulesDocument.version === campaign.rulesVersion ? "PASS" : "FAIL",
        detail: campaign.officialRulesDocument
          ? `Campaign is bound to rules v${campaign.officialRulesDocument.version}, checksum ${campaign.officialRulesDocument.checksum.slice(0, 12)}…`
          : "The campaign has no immutable Official Rules document binding.",
      },
      {
        key: "window",
        label: "Promotion and AMOE windows",
        status: campaign.startsAt < campaign.endsAt && campaign.startsAt < campaign.freeEntryEndsAt
          ? "PASS"
          : "FAIL",
        detail: campaign.startsAt < campaign.endsAt && campaign.startsAt < campaign.freeEntryEndsAt
          ? "Purchase and free-entry cutoffs both follow the opening instant; they may close independently."
          : "Purchase and free-entry cutoffs must each follow the campaign opening instant.",
      },
      {
        key: "disclosure",
        label: "No-purchase disclosure",
        status: /NO PURCHASE NECESSARY/i.test(campaign.noPurchaseDisclosure) ? "PASS" : "FAIL",
        detail: /NO PURCHASE NECESSARY/i.test(campaign.noPurchaseDisclosure)
          ? "Required disclosure is configured."
          : "Add the approved no-purchase disclosure.",
      },
      {
        key: "amoe",
        label: "Alternative method of entry",
        status: hasAmoeRule ? "PASS" : "FAIL",
        detail: hasAmoeRule
          ? "An active free-entry rule shares this campaign pool."
          : "No active AMOE entry rule was found.",
      },
      {
        key: "prize",
        label: "Prize schedule and value",
        status: campaign.prizes.length > 0
          && campaign.prizes.every((prize) => prize.approximateValueCents > 0)
          && campaign.prizes.every((prize) => prize.currency === viewer.tenant.currency)
          ? "PASS"
          : "FAIL",
        detail: campaign.prizes.length
          ? `${campaign.prizes.length} prize schedule item(s) configured in ${viewer.tenant.currency}.`
          : "No prize schedule is attached.",
      },
      {
        key: "cap",
        label: "Per-entrant entry cap",
        status: campaign.maxEntriesPerEntrant ? "PASS" : "WARN",
        detail: campaign.maxEntriesPerEntrant
          ? `Cap: ${campaign.maxEntriesPerEntrant.toString()} entries.`
          : "No per-entrant cap is configured; confirm this with counsel.",
      },
      {
        key: "configuration",
        label: "Immutable configuration fingerprint",
        status: campaign.configChecksum.length >= 32 ? "PASS" : "FAIL",
        detail: campaign.configChecksum.length >= 32
          ? "Campaign configuration checksum is present."
          : "Configuration fingerprint is missing or malformed.",
      },
      {
        key: "theme",
        label: "Published storefront theme",
        status: publishedTheme ? "PASS" : "FAIL",
        detail: publishedTheme
          ? `Theme v${publishedTheme.version} is published.`
          : "No published theme is available.",
      },
      {
        key: "audit",
        label: "Launch audit event",
        status: publishedCampaignIds.has(campaign.id) ? "PASS" : "WARN",
        detail: publishedCampaignIds.has(campaign.id)
          ? "Campaign publication is present in the audit trail."
          : "No matching CAMPAIGN_PUBLISHED audit record was found.",
      },
      {
        key: "draw",
        label: "Draw scheduled after close",
        status: campaign.drawAt && campaign.drawAt > (
          campaign.freeEntryEndsAt > campaign.endsAt ? campaign.freeEntryEndsAt : campaign.endsAt
        ) ? "PASS" : "WARN",
        detail: campaign.drawAt && campaign.drawAt > (
          campaign.freeEntryEndsAt > campaign.endsAt ? campaign.freeEntryEndsAt : campaign.endsAt
        )
          ? "Draw time follows both purchase and free-entry cutoffs."
          : "Set the draw after the latest configured entry cutoff.",
      },
    ] as const;

    let lifecycle = "DRAFT";
    if (campaign.status === "CLOSED" || latestDraw?.status === "CLOSED") lifecycle = "CLOSED";
    else if (latestDraw?.conductedAt) lifecycle = "DRAW_COMPLETE";
    else if (latestSnapshot?.status === "SEALED") lifecycle = "DRAW_READY";
    else if (now > campaign.endsAt) lifecycle = "RECONCILIATION";
    else if (now >= campaign.startsAt && now <= campaign.endsAt && campaign.status === "LIVE") lifecycle = "LIVE";
    else if (now < campaign.startsAt && campaign.approvedAt) lifecycle = "SCHEDULED";

    return {
      id: campaign.id,
      slug: campaign.slug,
      code: campaign.code,
      title: campaign.title,
      status: campaign.status,
      lifecycle,
      startsAt: campaign.startsAt,
      endsAt: campaign.endsAt,
      freeEntryEndsAt: campaign.freeEntryEndsAt,
      drawAt: campaign.drawAt,
      approvedAt: campaign.approvedAt,
      currentMultiplier: campaign.currentMultiplier,
      maxEntriesPerEntrant: campaign.maxEntriesPerEntrant?.toString() ?? null,
      counts: campaign._count,
      prizeValueCents: campaign.prizes.reduce(
        (total, prize) => total + prize.approximateValueCents * prize.quantity,
        0,
      ),
      latestSnapshot: latestSnapshot
        ? { ...latestSnapshot, totalEntries: latestSnapshot.totalEntries.toString() }
        : null,
      latestDraw,
      checks,
      passCount: checks.filter((check) => check.status === "PASS").length,
      issueCount: checks.filter((check) => check.status !== "PASS").length,
    };
  });

  return {
    identity: await getAdminIdentity(),
    metrics: {
      orderCount,
      capturedRevenueCents: revenue._sum.totalCents ?? 0,
      entrantCount,
      activeEntries: (entryBalance._sum.balance ?? 0n).toString(),
      pendingAmoe,
      openTickets,
    },
    campaigns: campaignOperations,
    integrations: integrationReadiness(),
  };
});

export const getAdminOrders = cache(async () => {
  const viewer = await requireStaffRole(["ADMIN", "OPERATIONS", "SUPPORT"]);
  const orders = await db.order.findMany({
    where: { tenantId: viewer.tenantId },
    include: {
      campaign: { select: { code: true, title: true } },
      entrant: { select: { id: true, name: true, normalizedEmail: true } },
      lines: {
        select: {
          id: true,
          productTitle: true,
          variantTitle: true,
          quantity: true,
          qualifyingCents: true,
          entries: true,
        },
      },
      refunds: {
        include: { allocations: true },
        orderBy: { createdAt: "desc" },
      },
      payments: {
        select: { provider: true, status: true, amountCents: true, processedAt: true },
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 250,
  });

  return {
    identity: await getAdminIdentity(),
    orders: orders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      customerName: order.customerName,
      email: order.email,
      currency: order.currency,
      totalCents: order.totalCents,
      subtotalCents: order.subtotalCents,
      discountCents: order.discountCents,
      shippingCents: order.shippingCents,
      taxCents: order.taxCents,
      entryTotal: order.entryTotal.toString(),
      createdAt: order.createdAt,
      paidAt: order.paidAt,
      campaign: order.campaign,
      entrant: order.entrant,
      lineCount: order.lines.reduce((total, line) => total + line.quantity, 0),
      lines: order.lines.map((line) => ({ ...line, entries: line.entries.toString() })),
      latestPayment: order.payments[0] ?? null,
      refunds: order.refunds.map((refund) => ({
        id: refund.id,
        status: refund.status,
        amountCents: refund.amountCents,
        merchandiseCents: refund.merchandiseCents,
        shippingCents: refund.shippingCents,
        taxCents: refund.taxCents,
        currency: refund.currency,
        reason: refund.reason,
        evidence: refund.evidence,
        providerReason: refund.providerReason,
        providerRefundId: refund.providerRefundId,
        idempotencyKey: refund.idempotencyKey,
        createdAt: refund.createdAt,
        processedAt: refund.processedAt,
        entriesReversed: refund.allocations.reduce((sum, item) => sum + item.entriesReversed, 0n).toString(),
      })),
    })),
  };
});

export const getAdminLedger = cache(async () => {
  const viewer = await requireStaffRole(["ADMIN", "OPERATIONS", "COMPLIANCE"]);
  const [events, accountSummary] = await Promise.all([
    db.entryLedgerEvent.findMany({
      where: { tenantId: viewer.tenantId },
      include: {
        account: {
          select: {
            balance: true,
            campaign: { select: { code: true, title: true } },
            entrant: { select: { name: true, normalizedEmail: true } },
          },
        },
        entitlement: {
          select: {
            originType: true,
            status: true,
            order: { select: { orderNumber: true } },
            freeEntrySubmission: { select: { confirmationCode: true } },
          },
        },
      },
      orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
      take: 500,
    }),
    db.entryAccount.aggregate({
      where: { tenantId: viewer.tenantId },
      _count: { id: true },
      _sum: { balance: true },
    }),
  ]);

  return {
    identity: await getAdminIdentity(),
    accountCount: accountSummary._count.id,
    totalBalance: (accountSummary._sum.balance ?? 0n).toString(),
    events: events.map((event) => ({
      id: event.id,
      kind: event.kind,
      delta: event.delta.toString(),
      reasonCode: event.reasonCode,
      actorType: event.actorType,
      actorId: event.actorId,
      effectiveAt: event.effectiveAt,
      recordedAt: event.recordedAt,
      campaign: event.account.campaign,
      entrant: event.account.entrant,
      accountBalance: event.account.balance.toString(),
      originType: event.entitlement?.originType ?? null,
      entitlementStatus: event.entitlement?.status ?? null,
      sourceReference: event.entitlement?.order?.orderNumber
        ?? event.entitlement?.freeEntrySubmission?.confirmationCode
        ?? null,
    })),
  };
});

export const getAdminAmoe = cache(async () => {
  const viewer = await requireStaffRole(["ADMIN", "OPERATIONS", "COMPLIANCE"]);
  const [submissions, grouped] = await Promise.all([
    db.freeEntrySubmission.findMany({
      where: { tenantId: viewer.tenantId },
      include: {
        campaign: { select: { code: true, title: true, freeEntryEndsAt: true } },
        entrant: {
          select: {
            name: true,
            normalizedEmail: true,
            region: true,
            postalCode: true,
            eligibilityAttested: true,
          },
        },
        entitlement: { select: { id: true, status: true, originalEntries: true } },
      },
      orderBy: { submittedAt: "desc" },
      take: 300,
    }),
    db.freeEntrySubmission.groupBy({
      by: ["status"],
      where: { tenantId: viewer.tenantId },
      _count: { _all: true },
    }),
  ]);

  return {
    identity: await getAdminIdentity(),
    counts: Object.fromEntries(grouped.map((group) => [group.status, group._count._all])),
    submissions: submissions.map((submission) => ({
      id: submission.id,
      confirmationCode: submission.confirmationCode,
      method: submission.method,
      status: submission.status,
      entriesRequested: submission.entriesRequested.toString(),
      rulesVersion: submission.rulesVersion,
      submittedAt: submission.submittedAt,
      receivedAt: submission.receivedAt,
      reviewedAt: submission.reviewedAt,
      reviewedBy: submission.reviewedBy,
      rejectionReason: submission.rejectionReason,
      submittedPhone: submittedContactPhone(submission.eligibilityJson),
      campaign: submission.campaign,
      entrant: submission.entrant,
      entitlement: submission.entitlement
        ? {
            ...submission.entitlement,
            originalEntries: submission.entitlement.originalEntries.toString(),
          }
        : null,
    })),
  };
});

export const getAdminDraws = cache(async () => {
  const viewer = await requireStaffRole(["ADMIN", "OPERATIONS", "COMPLIANCE"]);
  const campaigns = await db.campaign.findMany({
    where: { tenantId: viewer.tenantId },
    select: {
      id: true,
      code: true,
      title: true,
      status: true,
      endsAt: true,
      freeEntryEndsAt: true,
      drawAt: true,
      snapshots: {
        select: {
          id: true,
          version: true,
          status: true,
          cutoffAt: true,
          totalEntries: true,
          entrantCount: true,
          checksum: true,
          sealedAt: true,
          sealedBy: true,
          approvals: {
            select: {
              id: true,
              kind: true,
              status: true,
              approverId: true,
              notes: true,
              decidedAt: true,
            },
            orderBy: { kind: "asc" },
          },
          _count: { select: { rows: true } },
        },
        orderBy: { version: "desc" },
      },
      draws: {
        select: {
          id: true,
          status: true,
          provider: true,
          algorithm: true,
          algorithmVersion: true,
          seedHash: true,
          resultChecksum: true,
          operatorId: true,
          witnessId: true,
          conductedAt: true,
          createdAt: true,
          snapshot: { select: { version: true, checksum: true } },
          candidates: {
            select: {
              id: true,
              rank: true,
              selectedEntry: true,
              status: true,
              contactDeadline: true,
              verifiedAt: true,
              decisionReason: true,
              account: { select: { entrant: { select: { name: true, normalizedEmail: true, phone: true } } } },
              winner: { select: { id: true, status: true, publicName: true, publishedAt: true } },
            },
            orderBy: { rank: "asc" },
          },
        },
        orderBy: { createdAt: "desc" },
      },
      winners: {
        select: {
          id: true,
          slug: true,
          status: true,
          publicName: true,
          publicLocation: true,
          verifiedAt: true,
          publishedAt: true,
          fulfilledAt: true,
          entrant: { select: { name: true, normalizedEmail: true } },
          prize: { select: { name: true, approximateValueCents: true, currency: true } },
        },
        orderBy: { createdAt: "desc" },
      },
      adjustmentRequests: {
        select: {
          id: true,
          kind: true,
          status: true,
          delta: true,
          explanation: true,
          evidenceRef: true,
          disposition: true,
          decidedAt: true,
          appliedAt: true,
          createdAt: true,
          account: {
            select: {
              entrant: { select: { name: true, normalizedEmail: true } },
            },
          },
          refund: {
            select: {
              id: true,
              amountCents: true,
              currency: true,
              providerRefundId: true,
              order: { select: { orderNumber: true } },
            },
          },
          subscriptionCycle: {
            select: {
              id: true,
              cycleNumber: true,
              providerInvoiceId: true,
              settledAt: true,
              order: {
                select: {
                  orderNumber: true,
                  totalCents: true,
                  currency: true,
                },
              },
            },
          },
          approvals: {
            select: {
              id: true,
              kind: true,
              approverId: true,
              approverRole: true,
              evidenceRef: true,
              notes: true,
              disposition: true,
              createdAt: true,
            },
            orderBy: { createdAt: "asc" },
          },
        },
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { endsAt: "desc" },
  });

  return {
    identity: await getAdminIdentity(),
    demoMode: process.env.DEMO_MODE === "true",
    campaigns: campaigns.map((campaign) => ({
      ...campaign,
      snapshots: campaign.snapshots.map((snapshot) => ({
        ...snapshot,
        totalEntries: snapshot.totalEntries.toString(),
      })),
      draws: campaign.draws.map((draw) => ({
        ...draw,
        candidates: draw.candidates.map((candidate) => ({
          ...candidate,
          selectedEntry: candidate.selectedEntry.toString(),
          entrant: candidate.account.entrant,
          account: undefined,
        })),
      })),
      adjustmentRequests: campaign.adjustmentRequests.map((request) => ({
        ...request,
        delta: request.delta.toString(),
        entrant: request.account.entrant,
        account: undefined,
      })),
    })),
  };
});

export const getAdminConfiguration = cache(async () => {
  const viewer = await requireStaffRole(["ADMIN", "OPERATIONS"]);
  const [themes, products, collections, legalDocuments] = await Promise.all([
    db.themeVersion.findMany({
      where: { tenantId: viewer.tenantId },
      orderBy: { version: "desc" },
    }),
    db.product.findMany({
      where: { tenantId: viewer.tenantId },
      select: {
        id: true,
        slug: true,
        title: true,
        status: true,
        category: true,
        productType: true,
        priceCents: true,
        inventory: true,
        entryMultiplier: true,
        featured: true,
        variants: {
          select: { inventory: true, reservedInventory: true, status: true },
        },
        _count: { select: { variants: true, orderLines: true } },
      },
      orderBy: [{ status: "asc" }, { title: "asc" }],
    }),
    db.collection.findMany({
      where: { tenantId: viewer.tenantId },
      select: {
        id: true,
        slug: true,
        title: true,
        sortOrder: true,
        _count: { select: { products: true } },
      },
      orderBy: { sortOrder: "asc" },
    }),
    db.legalDocument.findMany({
      where: { tenantId: viewer.tenantId },
      select: {
        id: true,
        kind: true,
        slug: true,
        title: true,
        version: true,
        status: true,
        checksum: true,
        effectiveAt: true,
      },
      orderBy: [{ kind: "asc" }, { version: "desc" }],
    }),
  ]);

  const productsWithAvailableInventory = products.map((product) => {
    const { variants, ...productFacts } = product;
    return {
      ...productFacts,
      inventory: variants
        .filter((variant) => variant.status === "ACTIVE")
        .reduce((total, variant) => total + Math.max(0, variant.inventory - variant.reservedInventory), 0),
    };
  });

  return {
    identity: await getAdminIdentity(),
    themes: themes.map((theme) => ({
      id: theme.id,
      version: theme.version,
      name: theme.name,
      status: theme.status,
      checksum: theme.checksum,
      checksumValid: checksum(theme.configJson) === theme.checksum,
      publishedAt: theme.publishedAt,
      createdAt: theme.createdAt,
    })),
    products: productsWithAvailableInventory,
    collections,
    legalDocuments,
    catalog: {
      productCount: productsWithAvailableInventory.length,
      activeCount: productsWithAvailableInventory.filter((product) => product.status === "ACTIVE").length,
      lowStockCount: productsWithAvailableInventory.filter(
        (product) => product.productType === "PHYSICAL" && product.inventory <= 20,
      ).length,
      collectionCount: collections.length,
    },
    integrations: integrationReadiness(),
  };
});

export const getAdminAudit = cache(async () => {
  const viewer = await requireStaffRole(["ADMIN", "OPERATIONS", "COMPLIANCE", "SUPPORT"]);
  const [events, tickets] = await Promise.all([
    db.auditEvent.findMany({
      where: {
        tenantId: viewer.tenantId,
        ...(viewer.role.toUpperCase() === "SUPPORT" ? { resourceType: "SupportTicket" } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    db.supportTicket.findMany({
      where: { tenantId: viewer.tenantId },
      select: {
        id: true,
        name: true,
        email: true,
        subject: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);

  return {
    identity: await getAdminIdentity(),
    events: events.map((event) => ({
      id: event.id,
      actorType: event.actorType,
      actorId: event.actorId,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      requestId: event.requestId,
      reason: event.reason,
      createdAt: event.createdAt,
    })),
    tickets,
  };
});

export const getAdminSupportTicket = cache(async (ticketId: string) => {
  const viewer = await requireStaffRole(["ADMIN", "OPERATIONS", "SUPPORT"]);
  const ticket = await db.supportTicket.findFirst({
    where: { id: ticketId, tenantId: viewer.tenantId },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  if (!ticket) return null;
  return { identity: await getAdminIdentity(), ticket };
});
