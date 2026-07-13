import { z } from "zod";

const databaseId = z.string().trim().min(1).max(191);
const idempotencyKey = z.string().trim().min(8).max(200);
const providerIdentifier = z.string().trim().min(1).max(255);
const instant = z.union([
  z.date(),
  z.string().trim().min(1).pipe(z.coerce.date()),
]);

export const createDemoSubscriptionSchema = z.object({
  tenantId: databaseId,
  planId: databaseId,
  entrantId: databaseId,
  userId: databaseId,
  idempotencyKey,
}).strict();

export const settleSubscriptionRenewalSchema = z.object({
  tenantId: databaseId,
  subscriptionId: databaseId,
  provider: z.string().trim().min(1).max(40).transform((value) => value.toUpperCase()),
  providerEventId: providerIdentifier,
  providerPaymentId: providerIdentifier,
  capturedAmountCents: z.number().int().positive().safe(),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  occurredAt: instant,
  payloadHash: z.string().trim().regex(/^[a-fA-F0-9]{64}$/).transform((value) => value.toLowerCase()),
  idempotencyKey,
}).strict();

export const settleDemoSubscriptionRenewalSchema = z.object({
  tenantId: databaseId,
  subscriptionId: databaseId,
  idempotencyKey,
  occurredAt: instant.optional(),
}).strict();

export const cancelSubscriptionAtPeriodEndSchema = z.object({
  tenantId: databaseId,
  subscriptionId: databaseId,
  idempotencyKey,
}).strict();

export const finalizeSubscriptionCancellationSchema = z.object({
  tenantId: databaseId,
  subscriptionId: databaseId,
}).strict();

export type CreateDemoSubscriptionInput = z.infer<typeof createDemoSubscriptionSchema>;
export type SettleSubscriptionRenewalInput = z.infer<typeof settleSubscriptionRenewalSchema>;
export type SettleDemoSubscriptionRenewalInput = z.infer<typeof settleDemoSubscriptionRenewalSchema>;
export type CancelSubscriptionAtPeriodEndInput = z.infer<typeof cancelSubscriptionAtPeriodEndSchema>;
export type FinalizeSubscriptionCancellationInput = z.infer<typeof finalizeSubscriptionCancellationSchema>;
