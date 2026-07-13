import "server-only";

import { cache } from "react";
import { db } from "@/server/db";
import { getOptionalViewer, requireUser } from "@/server/auth/dal";
import { getRequestTenant } from "@/server/auth/tenant";

export const getMembershipOffers = cache(async (campaignId: string) => {
  const [tenant, viewer] = await Promise.all([getRequestTenant(), getOptionalViewer()]);
  const plans = await db.subscriptionPlan.findMany({
    where: {
      tenantId: tenant.id,
      status: "ACTIVE",
      product: { status: "ACTIVE", productType: "MEMBERSHIP" },
    },
    select: {
      id: true,
      tenantId: true,
      name: true,
      interval: true,
      intervalCount: true,
      priceCents: true,
      currency: true,
      product: {
        select: { id: true, slug: true, title: true, description: true, image: true },
      },
      entryBands: {
        where: { campaignId },
        select: {
          id: true,
          minimumSettledCycles: true,
          maximumSettledCycles: true,
          fixedEntries: true,
          multiplierNumerator: true,
          multiplierDenominator: true,
        },
        orderBy: { minimumSettledCycles: "asc" },
      },
    },
    orderBy: [{ priceCents: "asc" }, { id: "asc" }],
  });
  const campaign = await db.campaign.findFirst({
    where: { id: campaignId, tenantId: tenant.id },
    select: { officialRulesDocumentId: true, officialRulesChecksum: true },
  });
  const [existing, exactAcceptance] = await Promise.all([
    viewer && plans.length
      ? db.subscription.findMany({
        where: {
          tenantId: tenant.id,
          userId: viewer.userId,
          planId: { in: plans.map((plan) => plan.id) },
          status: { in: ["PENDING", "ACTIVE", "PAST_DUE"] },
        },
        select: { id: true, planId: true, status: true, cancelAtPeriodEnd: true },
      })
      : Promise.resolve([]),
    viewer && campaign?.officialRulesDocumentId && campaign.officialRulesChecksum
      ? db.rulesAcceptance.findFirst({
          where: {
            tenantId: tenant.id,
            campaignId,
            legalDocumentId: campaign.officialRulesDocumentId,
            documentChecksum: campaign.officialRulesChecksum,
            entrant: { userId: viewer.userId },
          },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);
  const existingByPlan = new Map(existing.map((subscription) => [subscription.planId, subscription]));
  return {
    tenant,
    viewer: viewer ? { userId: viewer.userId, name: viewer.name } : null,
    currentRulesAccepted: Boolean(exactAcceptance),
    offers: plans.map((plan) => ({ ...plan, existing: existingByPlan.get(plan.id) ?? null })),
  };
});

export const getMembershipOffer = cache(async (productId: string) => {
  const viewer = await getOptionalViewer();
  const plan = await db.subscriptionPlan.findFirst({
    where: {
      productId,
      status: "ACTIVE",
      ...(viewer ? { tenantId: viewer.tenantId } : {}),
    },
    select: {
      id: true,
      tenantId: true,
      name: true,
      interval: true,
      intervalCount: true,
      priceCents: true,
      currency: true,
    },
  });

  const existing = viewer && plan
    ? await db.subscription.findFirst({
        where: {
          tenantId: viewer.tenantId,
          userId: viewer.userId,
          planId: plan.id,
          status: { in: ["PENDING", "ACTIVE", "PAST_DUE"] },
        },
        select: { id: true, status: true, cancelAtPeriodEnd: true },
      })
    : null;

  return {
    plan,
    viewer: viewer ? { userId: viewer.userId, name: viewer.name } : null,
    existing,
  };
});

export const getAccountMemberships = cache(async () => {
  const viewer = await requireUser();
  const subscriptions = await db.subscription.findMany({
    where: { tenantId: viewer.tenantId, userId: viewer.userId },
    include: {
      plan: {
        select: {
          name: true,
          priceCents: true,
          currency: true,
          interval: true,
          intervalCount: true,
          product: { select: { title: true, slug: true } },
        },
      },
      cycles: {
        include: {
          order: {
            select: {
              orderNumber: true,
              entryTotal: true,
              paymentStatus: true,
              paidAt: true,
            },
          },
        },
        orderBy: { cycleNumber: "desc" },
        take: 24,
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return { viewer, subscriptions };
});
