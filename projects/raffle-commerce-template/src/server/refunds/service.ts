import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/server/db";
import {
  createStripeRefundBoundary,
  type StripeRefundBoundary,
} from "@/server/providers/stripe/refund-adapter";
import {
  refundAllocationFingerprint,
  stripeRefundMetadata,
} from "@/server/providers/stripe/refund-contract";
import { allocateRefund } from "./allocation";

const databaseId = z.string().trim().min(1).max(191);
const instant = z.union([z.date(), z.string().trim().min(1).pipe(z.coerce.date())]);

const demoRefundSchema = z.object({
  orderId: databaseId,
  amountCents: z.number().int().positive().safe(),
  merchandiseCents: z.number().int().nonnegative().safe().optional(),
  shippingCents: z.number().int().nonnegative().safe().optional(),
  taxCents: z.number().int().nonnegative().safe().optional(),
  reason: z.string().trim().min(5).max(500),
  actorId: databaseId,
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

export const initiateStripeRefundSchema = z.object({
  tenantId: databaseId,
  orderId: databaseId,
  actorId: databaseId,
  amountCents: z.number().int().positive().safe(),
  merchandiseCents: z.number().int().nonnegative().safe(),
  shippingCents: z.number().int().nonnegative().safe(),
  taxCents: z.number().int().nonnegative().safe(),
  reason: z.string().trim().min(5).max(500),
  evidence: z.string().trim().min(3).max(1000),
  providerReason: z.enum(["duplicate", "fraudulent", "requested_by_customer"]),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict().superRefine((input, context) => {
  if (input.merchandiseCents + input.shippingCents + input.taxCents !== input.amountCents) {
    context.addIssue({
      code: "custom",
      path: ["amountCents"],
      message: "Merchandise, shipping, and tax allocations must equal the refund amount",
    });
  }
});

export const settleRefundSchema = z.object({
  tenantId: databaseId,
  orderId: databaseId,
  refundId: databaseId,
  allocationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  provider: z.string().trim().min(1).max(40).transform((value) => value.toUpperCase()),
  providerPaymentId: z.string().trim().min(1).max(255),
  providerRefundId: z.string().trim().min(1).max(255),
  amountCents: z.number().int().positive().safe(),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  reason: z.string().trim().min(5).max(500),
  actorType: z.enum(["ADMIN", "PAYMENT_PROVIDER"]),
  actorId: z.string().trim().min(1).max(191),
  occurredAt: instant,
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

export const failStripeRefundSchema = z.object({
  tenantId: databaseId,
  orderId: databaseId,
  refundId: databaseId,
  allocationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  providerPaymentId: z.string().trim().min(1).max(255),
  providerRefundId: z.string().trim().min(1).max(255),
  providerEventId: z.string().trim().min(1).max(255),
  amountCents: z.number().int().positive().safe(),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  providerStatus: z.enum(["failed", "canceled"]),
  failureReason: z.string().trim().min(1).max(500),
  occurredAt: instant,
}).strict();

export type DemoRefundInput = z.infer<typeof demoRefundSchema>;
export type InitiateStripeRefundInput = z.infer<typeof initiateStripeRefundSchema>;
export type SettleRefundInput = z.infer<typeof settleRefundSchema>;
export type FailStripeRefundInput = z.infer<typeof failStripeRefundSchema>;

const sealedCampaignStates = [
  "SNAPSHOT_REVIEW",
  "SEALED",
  "DRAW_IN_PROGRESS",
  "WINNER_PENDING",
  "COMPLETED",
  "ARCHIVED",
];

type RefundReceipt = Awaited<ReturnType<typeof findSettlementRefund>>;

const MAX_SERIALIZATION_ATTEMPTS = 4;

class RefundSerializationConflict extends Error {
  constructor() {
    super("Refund settlement lost its order-state compare-and-swap");
    this.name = "RefundSerializationConflict";
  }
}

function prismaErrorCode(error: unknown) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function isUniqueConstraintError(error: unknown) {
  return prismaErrorCode(error) === "P2002";
}

function isSerializationConflict(error: unknown) {
  return error instanceof RefundSerializationConflict || prismaErrorCode(error) === "P2034";
}

async function findSettlementRefund(input: SettleRefundInput) {
  return db.refund.findFirst({
    where: { id: input.refundId, tenantId: input.tenantId },
    include: { allocations: true },
  });
}

function assertMatchingRefund(existing: NonNullable<RefundReceipt>, input: SettleRefundInput) {
  if (
    existing.orderId !== input.orderId
    || existing.status !== "COMPLETED"
    || existing.amountCents !== input.amountCents
    || existing.currency !== input.currency
    || existing.providerRefundId !== input.providerRefundId
    || existing.allocationFingerprint !== input.allocationFingerprint
  ) {
    throw new Error("Refund idempotency key conflicts with a different settlement");
  }
  return existing;
}

function assertMatchingIntent<T extends {
  orderId: string;
  requestedBy: string;
  amountCents: number;
  merchandiseCents: number;
  shippingCents: number;
  taxCents: number;
  reason: string;
  evidence: string;
  providerReason: string;
}>(existing: T, input: InitiateStripeRefundInput): T {
  if (
    existing.orderId !== input.orderId
    || existing.requestedBy !== input.actorId
    || existing.amountCents !== input.amountCents
    || existing.merchandiseCents !== input.merchandiseCents
    || existing.shippingCents !== input.shippingCents
    || existing.taxCents !== input.taxCents
    || existing.reason !== input.reason
    || existing.evidence !== input.evidence
    || existing.providerReason !== input.providerReason
  ) {
    throw new Error("Refund idempotency key conflicts with a different request");
  }
  return existing;
}

async function prepareStripeRefundIntent(input: InitiateStripeRefundInput) {
  const existing = await db.refund.findUnique({
    where: {
      tenantId_idempotencyKey: {
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    include: { allocations: true, payment: true },
  });
  if (existing) return assertMatchingIntent(existing, input);

  return db.$transaction(async (tx) => {
    const raced = await tx.refund.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: { allocations: true, payment: true },
    });
    if (raced) return assertMatchingIntent(raced, input);

    const actor = await tx.user.findFirst({
      where: {
        id: input.actorId,
        tenantId: input.tenantId,
        status: "ACTIVE",
        role: { in: ["ADMIN", "OPERATIONS"] },
      },
      select: { id: true, role: true },
    });
    if (!actor) throw new Error("Active refund operator not found");

    const order = await tx.order.findFirst({
      where: { id: input.orderId, tenantId: input.tenantId, provider: "STRIPE" },
      include: {
        payments: {
          where: {
            provider: "STRIPE",
            status: { in: ["CAPTURED", "PARTIALLY_REFUNDED"] },
          },
          orderBy: { createdAt: "asc" },
        },
        lines: {
          include: {
            refundAllocations: { where: { refund: { status: "COMPLETED" } } },
          },
        },
        refunds: { where: { status: { in: ["PENDING", "PROCESSING", "COMPLETED"] } } },
      },
    });
    if (!order || !["CAPTURED", "PARTIALLY_REFUNDED"].includes(order.paymentStatus)) {
      throw new Error("Captured Stripe order not found");
    }
    if (order.payments.length !== 1 || !order.payments[0]?.providerPaymentId) {
      throw new Error("Exactly one captured Stripe payment is required");
    }
    const payment = order.payments[0];
    if (payment.currency !== order.currency || payment.amountCents !== order.totalCents) {
      throw new Error("Captured Stripe payment does not reconcile to the order total");
    }
    const otherActiveIntent = order.refunds.find(
      (refund) => refund.status === "PENDING" || refund.status === "PROCESSING",
    );
    if (otherActiveIntent) throw new Error("This order already has a refund awaiting provider settlement");

    const completed = order.refunds.filter((refund) => refund.status === "COMPLETED");
    const refundedTotal = completed.reduce((sum, refund) => sum + refund.amountCents, 0);
    const refundedShipping = completed.reduce((sum, refund) => sum + refund.shippingCents, 0);
    const refundedTax = completed.reduce((sum, refund) => sum + refund.taxCents, 0);
    const refundableLines = order.lines.map((line) => ({
      lineId: line.id,
      originalAmountCents: line.qualifyingCents,
      originalEntries: line.entries,
      previouslyRefundedCents: line.refundAllocations.reduce((sum, item) => sum + item.amountCents, 0),
      previouslyReversedEntries: line.refundAllocations.reduce((sum, item) => sum + item.entriesReversed, 0n),
    }));
    const remainingMerchandise = refundableLines.reduce(
      (sum, line) => sum + line.originalAmountCents - line.previouslyRefundedCents,
      0,
    );
    if (refundedTotal + input.amountCents > payment.amountCents) {
      throw new Error("Refund exceeds the remaining captured order amount");
    }
    if (input.merchandiseCents > remainingMerchandise) {
      throw new Error("Refund exceeds the remaining merchandise amount");
    }
    if (input.shippingCents > order.shippingCents - refundedShipping) {
      throw new Error("Refund exceeds the remaining shipping amount");
    }
    if (input.taxCents > order.taxCents - refundedTax) {
      throw new Error("Refund exceeds the remaining tax amount");
    }

    const allocation = input.merchandiseCents > 0
      ? allocateRefund(refundableLines, input.merchandiseCents)
      : [];
    const allocationFingerprint = refundAllocationFingerprint({
      tenantId: order.tenantId,
      orderId: order.id,
      paymentId: payment.id,
      amountCents: input.amountCents,
      merchandiseCents: input.merchandiseCents,
      shippingCents: input.shippingCents,
      taxCents: input.taxCents,
      currency: order.currency,
      allocations: allocation.map((item) => ({
        orderLineId: item.lineId,
        amountCents: item.amountCents,
        entriesReversed: item.entriesToReverse,
      })),
    });

    const claimedAt = new Date(Math.max(Date.now(), order.updatedAt.getTime() + 1));
    const claim = await tx.order.updateMany({
      where: { id: order.id, tenantId: order.tenantId, updatedAt: order.updatedAt },
      data: { updatedAt: claimedAt },
    });
    if (claim.count !== 1) throw new RefundSerializationConflict();

    const refund = await tx.refund.create({
      data: {
        tenantId: order.tenantId,
        orderId: order.id,
        paymentId: payment.id,
        status: "PENDING",
        amountCents: input.amountCents,
        merchandiseCents: input.merchandiseCents,
        shippingCents: input.shippingCents,
        taxCents: input.taxCents,
        currency: order.currency,
        reason: input.reason,
        providerReason: input.providerReason,
        evidence: input.evidence,
        allocationFingerprint,
        idempotencyKey: input.idempotencyKey,
        requestedBy: actor.id,
        allocations: {
          create: allocation.map((item) => ({
            orderLineId: item.lineId,
            amountCents: item.amountCents,
            entriesReversed: item.entriesToReverse,
          })),
        },
      },
      include: { allocations: true, payment: true },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: order.tenantId,
        actorType: "ADMIN",
        actorId: actor.id,
        action: "REFUND_REQUESTED",
        resourceType: "Refund",
        resourceId: refund.id,
        reason: input.reason,
        metadataJson: JSON.stringify({
          orderId: order.id,
          orderNumber: order.orderNumber,
          amountCents: input.amountCents,
          merchandiseCents: input.merchandiseCents,
          shippingCents: input.shippingCents,
          taxCents: input.taxCents,
          providerReason: input.providerReason,
          evidence: input.evidence,
          allocationFingerprint,
          actorRole: actor.role,
        }),
      },
    });
    return refund;
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 15_000,
  });
}

/**
 * Creates or safely resumes a tenant-scoped Stripe refund request. Provider
 * settlement remains webhook-canonical; this boundary only reserves the exact
 * allocation and asks Stripe to create the refund with immutable metadata.
 */
export async function initiateStripeRefund(
  rawInput: unknown,
  boundary: StripeRefundBoundary = createStripeRefundBoundary(),
) {
  const input = initiateStripeRefundSchema.parse(rawInput);
  let refund;
  for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
    try {
      refund = await prepareStripeRefundIntent(input);
      break;
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === MAX_SERIALIZATION_ATTEMPTS) throw error;
    }
  }
  if (!refund) throw new Error("Refund initiation exhausted its serialization retries");
  if (refund.providerRefundId || ["COMPLETED", "FAILED"].includes(refund.status)) return refund;
  if (!refund.payment?.providerPaymentId) throw new Error("Refund payment identity is unavailable");

  const providerResult = await boundary.createRefund({
    providerPaymentId: refund.payment.providerPaymentId,
    amountCents: refund.amountCents,
    reason: input.providerReason,
    metadata: stripeRefundMetadata({
      tenantId: refund.tenantId,
      orderId: refund.orderId,
      refundId: refund.id,
      allocationFingerprint: refund.allocationFingerprint,
    }),
    idempotencyKey: `refund:${refund.tenantId}:${refund.idempotencyKey}`,
  });
  if (providerResult.status === "failed" || providerResult.status === "canceled") {
    await failStripeRefund({
      tenantId: refund.tenantId,
      orderId: refund.orderId,
      refundId: refund.id,
      allocationFingerprint: refund.allocationFingerprint,
      providerPaymentId: refund.payment.providerPaymentId,
      providerRefundId: providerResult.providerRefundId,
      providerEventId: `stripe-create-response:${providerResult.providerRefundId}`,
      amountCents: refund.amountCents,
      currency: refund.currency,
      providerStatus: providerResult.status,
      failureReason: `Stripe refund creation returned terminal status ${providerResult.status}`,
      occurredAt: new Date(),
    });
  } else {
    await db.refund.updateMany({
      where: { id: refund.id, tenantId: refund.tenantId, providerRefundId: null, status: "PENDING" },
      data: {
        providerRefundId: providerResult.providerRefundId,
        providerStatus: providerResult.status,
        status: "PROCESSING",
      },
    });
  }
  return db.refund.findUniqueOrThrow({ where: { id: refund.id }, include: { allocations: true } });
}

function assertMatchingFailedRefund<T extends {
  orderId: string;
  status: string;
  amountCents: number;
  currency: string;
  allocationFingerprint: string;
  providerRefundId: string | null;
  providerStatus: string | null;
}>(intent: T, input: FailStripeRefundInput) {
  if (
    intent.orderId !== input.orderId
    || intent.status !== "FAILED"
    || intent.amountCents !== input.amountCents
    || intent.currency !== input.currency
    || intent.allocationFingerprint !== input.allocationFingerprint
    || intent.providerRefundId !== input.providerRefundId
    || intent.providerStatus !== input.providerStatus
  ) {
    throw new Error("Stripe refund failure conflicts with the authorized refund intent");
  }
  return intent;
}

/**
 * Records a terminal provider failure without changing order money state or
 * consuming the authorized merchandise allocation. A later operator retry
 * must use a fresh local idempotency key and therefore creates a new intent.
 */
export async function failStripeRefund(rawInput: unknown) {
  const input = failStripeRefundSchema.parse(rawInput);
  return db.$transaction(async (tx) => {
    const intent = await tx.refund.findFirst({
      where: { id: input.refundId, tenantId: input.tenantId },
      include: { payment: true },
    });
    if (!intent) throw new Error("Authoritative refund intent not found");
    if (intent.status === "FAILED") {
      assertMatchingFailedRefund(intent, input);
      return { ...intent, idempotent: true };
    }
    if (!["PENDING", "PROCESSING"].includes(intent.status)) {
      throw new Error("Refund intent is not awaiting a terminal provider result");
    }
    if (
      intent.orderId !== input.orderId
      || intent.amountCents !== input.amountCents
      || intent.currency !== input.currency
      || intent.allocationFingerprint !== input.allocationFingerprint
      || (intent.providerRefundId && intent.providerRefundId !== input.providerRefundId)
      || intent.payment?.provider !== "STRIPE"
      || intent.payment.providerPaymentId !== input.providerPaymentId
    ) {
      throw new Error("Stripe refund failure conflicts with the authorized refund intent");
    }

    const failed = await tx.refund.updateMany({
      where: {
        id: intent.id,
        tenantId: input.tenantId,
        status: { in: ["PENDING", "PROCESSING"] },
        OR: [{ providerRefundId: null }, { providerRefundId: input.providerRefundId }],
      },
      data: {
        status: "FAILED",
        providerRefundId: input.providerRefundId,
        providerStatus: input.providerStatus,
        providerEventId: input.providerEventId,
        failureReason: input.failureReason,
        failedAt: input.occurredAt,
        processedAt: input.occurredAt,
      },
    });
    if (failed.count !== 1) {
      throw new RefundSerializationConflict();
    }
    await tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: "PAYMENT_PROVIDER",
        actorId: "STRIPE",
        action: input.providerStatus === "canceled"
          ? "STRIPE_REFUND_CANCELED"
          : "STRIPE_REFUND_FAILED",
        resourceType: "Refund",
        resourceId: intent.id,
        reason: input.failureReason,
        metadataJson: JSON.stringify({
          orderId: input.orderId,
          providerPaymentId: input.providerPaymentId,
          providerRefundId: input.providerRefundId,
          providerEventId: input.providerEventId,
          providerStatus: input.providerStatus,
          amountCents: input.amountCents,
          currency: input.currency,
          allocationFingerprint: input.allocationFingerprint,
          retryAuthorizedWithFreshIdempotencyKey: true,
        }),
      },
    });
    return {
      ...await tx.refund.findUniqueOrThrow({ where: { id: intent.id } }),
      idempotent: false,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/**
 * Canonical refund settlement. Provider adapters supply verified provider ids;
 * this service re-reads the paid order, payment, prior allocations, campaign
 * seal state, and account balance. Before freeze it reverses the append-only
 * ledger atomically; after freeze it commits money state and opens a controlled
 * adjustment case without mutating the historical snapshot.
 */
export async function settleRefund(rawInput: unknown) {
  const input = settleRefundSchema.parse(rawInput);
  const existing = await findSettlementRefund(input);
  if (existing?.status === "COMPLETED") return assertMatchingRefund(existing, input);
  if (!existing) throw new Error("Authoritative refund intent not found");

  for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        // The fast-path lookup above avoids a transaction for ordinary webhook
        // replays. This second lookup is authoritative when two deliveries race.
        const intent = await tx.refund.findFirst({
          where: { id: input.refundId, tenantId: input.tenantId },
          include: { allocations: true },
        });
        if (!intent) throw new Error("Authoritative refund intent not found");
        if (intent.status === "COMPLETED") return assertMatchingRefund(intent, input);
        if (!["PENDING", "PROCESSING"].includes(intent.status)) {
          throw new Error("Refund intent is not awaiting settlement");
        }
        if (
          intent.orderId !== input.orderId
          || intent.amountCents !== input.amountCents
          || intent.currency !== input.currency
          || intent.allocationFingerprint !== input.allocationFingerprint
          || (intent.providerRefundId && intent.providerRefundId !== input.providerRefundId)
          || intent.merchandiseCents + intent.shippingCents + intent.taxCents !== intent.amountCents
        ) {
          throw new Error("Provider settlement conflicts with the authorized refund intent");
        }
        if (intent.allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0)
          !== intent.merchandiseCents) {
          throw new Error("Refund merchandise allocation does not match its authorized total");
        }

        const order = await tx.order.findFirst({
          where: { id: input.orderId, tenantId: input.tenantId },
          include: {
            campaign: true,
            payments: {
              where: {
                provider: input.provider,
                providerPaymentId: input.providerPaymentId,
                status: { in: ["CAPTURED", "PARTIALLY_REFUNDED"] },
              },
              orderBy: { createdAt: "asc" },
            },
            lines: {
              include: {
                product: true,
                variant: true,
                entitlements: { where: { status: "POSTED" }, include: { ledgerEvents: true } },
                refundAllocations: { where: { refund: { status: "COMPLETED" } } },
              },
            },
            refunds: { where: { status: "COMPLETED" }, include: { allocations: true } },
          },
        });
        if (!order || order.paymentStatus === "UNPAID") throw new Error("Paid order not found");
        if (order.provider.toUpperCase() !== input.provider) {
          throw new Error("Refund provider does not match the order provider");
        }
        if (order.currency !== input.currency) throw new Error("Refund currency does not match the order");
        const entriesAreFrozen = Boolean(
          order.campaign && sealedCampaignStates.includes(order.campaign.status),
        );
        const payment = order.payments[0];
        if (!payment || order.payments.length !== 1) {
          throw new Error("Exactly one matching captured payment is required");
        }
        if (payment.currency !== input.currency || payment.amountCents !== order.totalCents) {
          throw new Error("Captured payment does not reconcile to the refund order");
        }
        if (intent.paymentId !== payment.id) throw new Error("Refund intent payment does not match");

        const refundableLines = order.lines.map((line) => ({
          lineId: line.id,
          originalAmountCents: line.qualifyingCents,
          originalEntries: line.entries,
          previouslyRefundedCents: line.refundAllocations.reduce(
            (sum, item) => sum + item.amountCents,
            0,
          ),
          previouslyReversedEntries: line.refundAllocations.reduce(
            (sum, item) => sum + item.entriesReversed,
            0n,
          ),
        }));
        const refundableByLine = new Map(refundableLines.map((line) => [line.lineId, line]));
        for (const authorized of intent.allocations) {
          const line = refundableByLine.get(authorized.orderLineId);
          if (
            !line
            || authorized.amountCents > line.originalAmountCents - line.previouslyRefundedCents
            || authorized.entriesReversed > line.originalEntries - line.previouslyReversedEntries
          ) {
            throw new Error("Refund allocation exceeds the remaining authorized merchandise entitlement");
          }
        }
        const existingRefunded = order.refunds.reduce((sum, refund) => sum + refund.amountCents, 0);
        if (existingRefunded + input.amountCents > payment.amountCents) {
          throw new Error("Refund exceeds the remaining captured order amount");
        }
        const existingShippingRefunded = order.refunds.reduce((sum, refund) => sum + refund.shippingCents, 0);
        const existingTaxRefunded = order.refunds.reduce((sum, refund) => sum + refund.taxCents, 0);
        if (intent.shippingCents > order.shippingCents - existingShippingRefunded) {
          throw new Error("Refund exceeds the remaining shipping amount");
        }
        if (intent.taxCents > order.taxCents - existingTaxRefunded) {
          throw new Error("Refund exceeds the remaining tax amount");
        }
        const expectedFingerprint = refundAllocationFingerprint({
          tenantId: intent.tenantId,
          orderId: intent.orderId,
          paymentId: payment.id,
          amountCents: intent.amountCents,
          merchandiseCents: intent.merchandiseCents,
          shippingCents: intent.shippingCents,
          taxCents: intent.taxCents,
          currency: intent.currency,
          allocations: intent.allocations.map((allocation) => ({
            orderLineId: allocation.orderLineId,
            amountCents: allocation.amountCents,
            entriesReversed: allocation.entriesReversed,
          })),
        });
        if (expectedFingerprint !== input.allocationFingerprint) {
          throw new Error("Refund allocation fingerprint does not match the authorized intent");
        }
        const allocationByLine = new Map(intent.allocations.map((item) => [item.orderLineId, item]));
        const entriesToReverse = intent.allocations.reduce((sum, item) => sum + item.entriesReversed, 0n);
        const fullyRefunded = existingRefunded + input.amountCents === payment.amountCents;
        const paymentStatus = fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED";
        const isDemo = input.provider === "DEMO";
        const reasonCode = entriesAreFrozen
          ? "REFUND_SETTLED_ADJUSTMENT_REQUIRED"
          : isDemo ? "DEMO_REFUND_SETTLED" : "REFUND_SETTLED";

        // updatedAt is the order settlement version. Distinct refund events that
        // read the same prior allocations cannot both claim it. Serializable
        // transactions turn a database-level write race into P2034; updateMany
        // also provides a portable optimistic guard at weaker isolation levels.
        const claimedAt = new Date(Math.max(Date.now(), order.updatedAt.getTime() + 1));
        const claim = await tx.order.updateMany({
          where: { id: order.id, tenantId: order.tenantId, updatedAt: order.updatedAt },
          data: { paymentStatus, updatedAt: claimedAt },
        });
        if (claim.count !== 1) throw new RefundSerializationConflict();

        await tx.refund.update({
          where: { id: intent.id },
          data: {
            status: "COMPLETED",
            providerRefundId: input.providerRefundId,
            providerStatus: "succeeded",
            processedAt: input.occurredAt,
          },
        });
        const refund = { ...intent, status: "COMPLETED", providerRefundId: input.providerRefundId, processedAt: input.occurredAt };

        if (entriesToReverse > 0n) {
          if (entriesAreFrozen) {
            if (!order.campaignId) throw new Error("Frozen order campaign is missing");
            const account = await tx.entryAccount.findUnique({
              where: {
                campaignId_entrantId: {
                  campaignId: order.campaignId,
                  entrantId: order.entrantId,
                },
              },
              select: { id: true },
            });
            if (!account) throw new Error("Frozen refund entry account not found");
            await tx.entryAdjustmentRequest.create({
              data: {
                tenantId: order.tenantId,
                campaignId: order.campaignId,
                entryAccountId: account.id,
                refundId: refund.id,
                requestedBy: intent.requestedBy,
                kind: "POST_FREEZE_REFUND_REVERSAL",
                delta: -entriesToReverse,
                reasonCode,
                explanation: intent.reason,
                evidenceRef: input.providerRefundId,
                status: "PENDING",
              },
            });
          } else {
            const accountIds = new Set(
              order.lines.flatMap((line) => line.entitlements.map((item) => item.entryAccountId)),
            );
            if (accountIds.size !== 1) throw new Error("Order entry entitlements do not share one account");
            const accountId = [...accountIds][0];
            if (!accountId) throw new Error("Order entry account not found");
            for (const line of order.lines) {
              const item = allocationByLine.get(line.id);
              if (!item || item.entriesReversed <= 0n) continue;
              const entitlement = line.entitlements[0];
              if (!entitlement) throw new Error(`Entry entitlement missing for order line ${line.id}`);
              const originalGrant = entitlement.ledgerEvents.find((event) => event.kind === "GRANT");
              await tx.entryLedgerEvent.create({
                data: {
                  tenantId: order.tenantId,
                  entryAccountId: entitlement.entryAccountId,
                  entitlementId: entitlement.id,
                  kind: "REVERSAL",
                  delta: -item.entriesReversed,
                  reversesEventId: originalGrant?.id,
                  idempotencyKey: `refund:${refund.id}:${line.id}`,
                  effectiveAt: input.occurredAt,
                  actorType: input.actorType,
                  actorId: input.actorId,
                  reasonCode,
                  metadataJson: JSON.stringify({
                    refundId: refund.id,
                    providerRefundId: input.providerRefundId,
                    orderNumber: order.orderNumber,
                    amountCents: item.amountCents,
                  }),
                },
              });
            }
            const account = await tx.entryAccount.findUnique({ where: { id: accountId } });
            if (!account || account.balance < entriesToReverse) {
              throw new Error("Refund reversal would make the entry balance negative");
            }
            await tx.entryAccount.update({
              where: { id: accountId },
              data: { balance: { decrement: entriesToReverse }, version: { increment: 1 } },
            });
          }
        }
        await tx.payment.update({ where: { id: payment.id }, data: { status: paymentStatus } });
        await tx.auditEvent.create({
          data: {
            tenantId: order.tenantId,
            actorType: input.actorType,
            actorId: input.actorId,
            action: reasonCode,
            resourceType: "Refund",
            resourceId: refund.id,
            reason: intent.reason,
            metadataJson: JSON.stringify({
              provider: input.provider,
              providerRefundId: input.providerRefundId,
              orderNumber: order.orderNumber,
              amountCents: input.amountCents,
              merchandiseCents: intent.merchandiseCents,
              shippingCents: intent.shippingCents,
              taxCents: intent.taxCents,
              evidence: intent.evidence,
              allocationFingerprint: intent.allocationFingerprint,
              entriesReversed: entriesToReverse.toString(),
              entryAdjustmentRequired: entriesAreFrozen && entriesToReverse > 0n,
            }),
          },
        });
        await tx.outboxEvent.create({
          data: {
            tenantId: order.tenantId,
            aggregateType: "Refund",
            aggregateId: refund.id,
            kind: "REFUND_SETTLED_NOTIFICATION",
            payloadJson: JSON.stringify({ orderId: order.id, refundId: refund.id }),
            idempotencyKey: `refund-notification:${refund.id}`,
          },
        });
        return refund;
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 15_000,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const raced = await findSettlementRefund(input);
        if (!raced) throw error;
        return assertMatchingRefund(raced, input);
      }
      if (!isSerializationConflict(error) || attempt === MAX_SERIALIZATION_ATTEMPTS) throw error;
    }
  }

  throw new Error("Refund settlement exhausted its serialization retries");
}

export async function settleDemoRefund(rawInput: DemoRefundInput) {
  if (process.env.DEMO_MODE !== "true") {
    throw new Error("Synthetic refund mutation is disabled outside demo mode");
  }
  const input = demoRefundSchema.parse(rawInput);
  let intent: Awaited<ReturnType<typeof db.refund.findUnique>> = null;
  for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
    try {
      intent = await db.$transaction(async (tx) => {
        const existing = await tx.refund.findUnique({
          where: {
            tenantId_idempotencyKey: {
              tenantId: (await tx.order.findUniqueOrThrow({
                where: { id: input.orderId },
                select: { tenantId: true },
              })).tenantId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (existing) {
          if (existing.orderId !== input.orderId || existing.amountCents !== input.amountCents) {
            throw new Error("Refund idempotency key conflicts with a different request");
          }
          return existing;
        }

        const order = await tx.order.findUnique({
          where: { id: input.orderId },
          include: {
            payments: {
              where: { provider: "DEMO", status: { in: ["CAPTURED", "PARTIALLY_REFUNDED"] } },
              orderBy: { createdAt: "asc" },
            },
            lines: {
              include: {
                refundAllocations: { where: { refund: { status: "COMPLETED" } } },
              },
            },
            refunds: { where: { status: "COMPLETED" } },
          },
        });
        if (!order || order.provider !== "DEMO" || !order.payments[0]?.providerPaymentId) {
          throw new Error("Paid demo order not found");
        }
        if (order.payments.length !== 1) throw new Error("Exactly one demo payment is required");
        const refundedTotal = order.refunds.reduce((sum, refund) => sum + refund.amountCents, 0);
        if (refundedTotal + input.amountCents > order.totalCents) {
          throw new Error("Refund exceeds the remaining captured order amount");
        }
        const refundableLines = order.lines.map((line) => ({
          lineId: line.id,
          originalAmountCents: line.qualifyingCents,
          originalEntries: line.entries,
          previouslyRefundedCents: line.refundAllocations.reduce((sum, item) => sum + item.amountCents, 0),
          previouslyReversedEntries: line.refundAllocations.reduce((sum, item) => sum + item.entriesReversed, 0n),
        }));
        const remainingMerchandise = refundableLines.reduce(
          (sum, line) => sum + line.originalAmountCents - line.previouslyRefundedCents,
          0,
        );
        const refundedShipping = order.refunds.reduce((sum, refund) => sum + refund.shippingCents, 0);
        const refundedTax = order.refunds.reduce((sum, refund) => sum + refund.taxCents, 0);
        const remainingShipping = order.shippingCents - refundedShipping;
        const remainingTax = order.taxCents - refundedTax;
        const explicitAllocation = input.merchandiseCents !== undefined
          || input.shippingCents !== undefined
          || input.taxCents !== undefined;
        let merchandiseCents: number;
        let shippingCents: number;
        let taxCents: number;
        if (explicitAllocation) {
          merchandiseCents = input.merchandiseCents ?? 0;
          shippingCents = input.shippingCents ?? 0;
          taxCents = input.taxCents ?? 0;
          if (merchandiseCents + shippingCents + taxCents !== input.amountCents) {
            throw new Error("Demo refund allocations must equal the refund amount");
          }
        } else {
          merchandiseCents = Math.min(input.amountCents, remainingMerchandise);
          let remainder = input.amountCents - merchandiseCents;
          shippingCents = Math.min(remainder, remainingShipping);
          remainder -= shippingCents;
          taxCents = Math.min(remainder, remainingTax);
          remainder -= taxCents;
          if (remainder !== 0) throw new Error("Demo refund amount cannot be allocated to the order");
        }
        if (merchandiseCents > remainingMerchandise) {
          throw new Error("Demo refund exceeds remaining merchandise");
        }
        if (shippingCents > remainingShipping) throw new Error("Demo refund exceeds remaining shipping");
        if (taxCents > remainingTax) throw new Error("Demo refund exceeds remaining tax");
        const allocation = merchandiseCents > 0
          ? allocateRefund(refundableLines, merchandiseCents)
          : [];
        const payment = order.payments[0];
        const allocationFingerprint = refundAllocationFingerprint({
          tenantId: order.tenantId,
          orderId: order.id,
          paymentId: payment.id,
          amountCents: input.amountCents,
          merchandiseCents,
          shippingCents,
          taxCents,
          currency: order.currency,
          allocations: allocation.map((item) => ({
            orderLineId: item.lineId,
            amountCents: item.amountCents,
            entriesReversed: item.entriesToReverse,
          })),
        });
        const claimedAt = new Date(Math.max(Date.now(), order.updatedAt.getTime() + 1));
        const claim = await tx.order.updateMany({
          where: { id: order.id, tenantId: order.tenantId, updatedAt: order.updatedAt },
          data: { updatedAt: claimedAt },
        });
        if (claim.count !== 1) throw new RefundSerializationConflict();
        return tx.refund.create({
          data: {
            tenantId: order.tenantId,
            orderId: order.id,
            paymentId: payment.id,
            status: "PROCESSING",
            amountCents: input.amountCents,
            merchandiseCents,
            shippingCents,
            taxCents,
            currency: order.currency,
            reason: input.reason,
            providerReason: "requested_by_customer",
            evidence: "demo://operator-confirmation",
            allocationFingerprint,
            providerRefundId: `demo_refund_${input.idempotencyKey}`,
            idempotencyKey: input.idempotencyKey,
            requestedBy: input.actorId,
            allocations: {
              create: allocation.map((item) => ({
                orderLineId: item.lineId,
                amountCents: item.amountCents,
                entriesReversed: item.entriesToReverse,
              })),
            },
          },
        });
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 15_000,
      });
      break;
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === MAX_SERIALIZATION_ATTEMPTS) throw error;
    }
  }
  if (!intent) throw new Error("Demo refund initiation exhausted its serialization retries");
  const order = await db.order.findUniqueOrThrow({
    where: { id: intent.orderId },
    include: { payments: { where: { id: intent.paymentId ?? "" } } },
  });
  const providerPaymentId = order.payments[0]?.providerPaymentId;
  const providerRefundId = intent.providerRefundId;
  if (!providerPaymentId || !providerRefundId) throw new Error("Paid demo order not found");

  return settleRefund({
    tenantId: order.tenantId,
    orderId: input.orderId,
    refundId: intent.id,
    allocationFingerprint: intent.allocationFingerprint,
    provider: "DEMO",
    providerPaymentId,
    providerRefundId,
    amountCents: input.amountCents,
    currency: order.currency,
    reason: input.reason,
    actorType: "ADMIN",
    actorId: input.actorId,
    occurredAt: new Date(),
    idempotencyKey: input.idempotencyKey,
  });
}
