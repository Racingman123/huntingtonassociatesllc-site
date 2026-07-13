import "server-only";

import { cache } from "react";
import { notFound } from "next/navigation";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth/dal";
import type {
  AccountData,
  AccountLedgerItem,
  AccountOrder,
} from "./types";

function mapOrder(order: {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  currency: string;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  entryTotal: bigint;
  createdAt: Date;
  paidAt: Date | null;
  campaign: { code: string; title: string; slug: string } | null;
  lines: Array<{
    id: string;
    productTitle: string;
    variantTitle: string | null;
    sku: string | null;
    quantity: number;
    unitPriceCents: number;
    entries: bigint;
  }>;
  payments: Array<{ status: string; amountCents: number; processedAt: Date | null }>;
}): AccountOrder {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    currency: order.currency,
    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    shippingCents: order.shippingCents,
    taxCents: order.taxCents,
    totalCents: order.totalCents,
    entryTotal: order.entryTotal.toString(),
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    campaign: order.campaign,
    lines: order.lines.map((line) => ({
      id: line.id,
      title: line.productTitle,
      variantTitle: line.variantTitle,
      sku: line.sku,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      entries: line.entries.toString(),
    })),
    payments: order.payments,
  };
}

function mapLedgerItem(event: {
  id: string;
  kind: string;
  delta: bigint;
  reasonCode: string;
  effectiveAt: Date;
  recordedAt: Date;
  actorType: string;
  account: {
    balance: bigint;
    campaign: { code: string; title: string; slug: string };
  };
  entitlement: null | {
    originType: string;
    order: { orderNumber: string } | null;
    freeEntrySubmission: { confirmationCode: string } | null;
  };
}): AccountLedgerItem {
  const sourceReference = event.entitlement?.order?.orderNumber
    ?? event.entitlement?.freeEntrySubmission?.confirmationCode
    ?? null;
  return {
    id: event.id,
    kind: event.kind,
    delta: event.delta.toString(),
    balanceContext: event.account.balance.toString(),
    reasonCode: event.reasonCode,
    effectiveAt: event.effectiveAt,
    recordedAt: event.recordedAt,
    actorType: event.actorType,
    campaign: event.account.campaign,
    originType: event.entitlement?.originType ?? null,
    sourceReference,
  };
}

function ownedOrderWhere(viewer: { userId: string; tenantId: string }, entrantId?: string) {
  return {
    tenantId: viewer.tenantId,
    OR: entrantId
      ? [{ userId: viewer.userId }, { entrantId }]
      : [{ userId: viewer.userId }],
  };
}

const orderInclude = {
  campaign: { select: { code: true, title: true, slug: true } },
  lines: {
    select: {
      id: true,
      productTitle: true,
      variantTitle: true,
      sku: true,
      quantity: true,
      unitPriceCents: true,
      entries: true,
    },
    orderBy: { createdAt: "asc" as const },
  },
  payments: {
    select: { status: true, amountCents: true, processedAt: true },
    orderBy: { createdAt: "desc" as const },
  },
} as const;

export const getAccountData = cache(async (): Promise<AccountData> => {
  const viewer = await requireUser();
  const user = await db.user.findFirst({
    where: { id: viewer.userId, tenantId: viewer.tenantId, status: "ACTIVE" },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
      emailVerifiedAt: true,
      lastLoginAt: true,
      entrant: {
        select: {
          id: true,
          name: true,
          phone: true,
          region: true,
          postalCode: true,
          eligibilityAttested: true,
        },
      },
    },
  });
  if (!user) notFound();

  const [orders, entryAccounts, ledger, activeSessionCount] = await Promise.all([
    db.order.findMany({
      where: ownedOrderWhere(viewer, user.entrant?.id),
      include: orderInclude,
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    user.entrant
      ? db.entryAccount.findMany({
          where: { tenantId: viewer.tenantId, entrantId: user.entrant.id },
          select: {
            id: true,
            balance: true,
            campaign: {
              select: {
                code: true,
                title: true,
                slug: true,
                status: true,
                endsAt: true,
              },
            },
          },
          orderBy: { campaign: { endsAt: "desc" } },
        })
      : Promise.resolve([]),
    user.entrant
      ? db.entryLedgerEvent.findMany({
          where: {
            tenantId: viewer.tenantId,
            account: { entrantId: user.entrant.id },
          },
          select: {
            id: true,
            kind: true,
            delta: true,
            reasonCode: true,
            effectiveAt: true,
            recordedAt: true,
            actorType: true,
            account: {
              select: {
                balance: true,
                campaign: { select: { code: true, title: true, slug: true } },
              },
            },
            entitlement: {
              select: {
                originType: true,
                order: { select: { orderNumber: true } },
                freeEntrySubmission: { select: { confirmationCode: true } },
              },
            },
          },
          orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
          take: 250,
        })
      : Promise.resolve([]),
    db.session.count({
      where: {
        userId: viewer.userId,
        tenantId: viewer.tenantId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    }),
  ]);

  const mappedOrders = orders.map(mapOrder);
  const capturedSpendCents = mappedOrders
    .filter((order) => ["CAPTURED", "PAID"].includes(order.paymentStatus))
    .reduce((total, order) => total + order.totalCents, 0);
  const activeEntries = entryAccounts.reduce((total, account) => total + account.balance, 0n);

  return {
    viewer: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
      emailVerifiedAt: user.emailVerifiedAt,
      lastLoginAt: user.lastLoginAt,
      sessionExpiresAt: viewer.sessionExpiresAt,
      activeSessionCount,
      tenant: { currency: viewer.tenant.currency },
    },
    entrant: user.entrant
      ? {
          name: user.entrant.name,
          phone: user.entrant.phone,
          region: user.entrant.region,
          postalCode: user.entrant.postalCode,
          eligibilityAttested: user.entrant.eligibilityAttested,
        }
      : null,
    orders: mappedOrders,
    entryPools: entryAccounts.map((account) => ({
      id: account.id,
      balance: account.balance.toString(),
      campaign: account.campaign,
    })),
    ledger: ledger.map(mapLedgerItem),
    totals: {
      orderCount: mappedOrders.length,
      capturedSpendCents,
      activeEntries: activeEntries.toString(),
    },
  };
});

export const getOwnedOrder = cache(async (orderNumber: string) => {
  const viewer = await requireUser();
  const entrant = await db.entrant.findUnique({
    where: { userId: viewer.userId },
    select: { id: true },
  });
  const order = await db.order.findFirst({
    where: {
      ...ownedOrderWhere(viewer, entrant?.id),
      orderNumber,
    },
    include: {
      ...orderInclude,
      entitlements: {
        select: {
          id: true,
          originType: true,
          status: true,
          originalEntries: true,
          effectiveAt: true,
          ledgerEvents: {
            select: { id: true, kind: true, delta: true, reasonCode: true, recordedAt: true },
            orderBy: { recordedAt: "asc" },
          },
        },
      },
    },
  });
  if (!order) notFound();

  return {
    ...mapOrder(order),
    shippingAddress: safeAddress(order.shippingAddressJson),
    entitlements: order.entitlements.map((entitlement) => ({
      id: entitlement.id,
      originType: entitlement.originType,
      status: entitlement.status,
      originalEntries: entitlement.originalEntries.toString(),
      effectiveAt: entitlement.effectiveAt,
      ledgerEvents: entitlement.ledgerEvents.map((event) => ({
        ...event,
        delta: event.delta.toString(),
      })),
    })),
  };
});

function safeAddress(value: string) {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const pick = (key: string) => typeof parsed[key] === "string" ? parsed[key] as string : null;
    return {
      line1: pick("line1") ?? pick("address1"),
      line2: pick("line2") ?? pick("address2"),
      city: pick("city"),
      region: pick("region") ?? pick("state"),
      postalCode: pick("postalCode") ?? pick("zip"),
      country: pick("country"),
      phone: pick("phone"),
    };
  } catch {
    return null;
  }
}
