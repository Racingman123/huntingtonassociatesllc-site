import "server-only";

export type Money = { amountCents: number; currency: string };

export type CanonicalPaymentEvent = {
  provider: string;
  providerEventId: string;
  providerPaymentId: string;
  kind: "PAYMENT_CAPTURED" | "PAYMENT_FAILED" | "REFUND_SETTLED" | "DISPUTE_OPENED" | "DISPUTE_WON" | "CHARGEBACK_SETTLED";
  amount: Money;
  occurredAt: Date;
  metadata: Record<string, string>;
  payloadHash: string;
};

export interface PaymentGateway {
  createCheckout(input: {
    orderId: string;
    orderNumber: string;
    email: string;
    amount: Money;
    successUrl: string;
    cancelUrl: string;
  }, idempotencyKey: string): Promise<{ checkoutId: string; redirectUrl: string }>;
  refund(input: { providerPaymentId: string; amount: Money; reason: string }, idempotencyKey: string): Promise<{ providerRefundId: string; status: string }>;
  verifyAndParseWebhook(rawBody: Uint8Array, headers: Headers): Promise<CanonicalPaymentEvent>;
}

export interface NotificationProvider {
  send(input: {
    to: string;
    template: string;
    data: Record<string, string>;
  }, idempotencyKey: string): Promise<{ deliveryId: string; acceptedAt: Date }>;
}

export interface DrawAdministrator {
  submitSnapshot(input: {
    campaignId: string;
    snapshotId: string;
    checksum: string;
    canonicalCsv: string;
  }): Promise<{ externalDrawId: string; status: string }>;
  fetchStatus(externalDrawId: string): Promise<{ status: string; updatedAt: Date }>;
  verifyAndImportResult(input: Uint8Array): Promise<{
    snapshotChecksum: string;
    orderedCandidates: Array<{ accountId: string; selectedEntry: bigint }>;
    resultChecksum: string;
  }>;
}

export interface ObjectStorage {
  putImmutable(input: { key: string; body: Uint8Array; contentType: string; checksum: string }): Promise<{ key: string; version: string }>;
  createSignedDownload(key: string, expiresInSeconds: number): Promise<string>;
}

export interface DurableJobQueue {
  enqueue(input: { kind: string; payload: Record<string, unknown>; runAfter?: Date }, idempotencyKey: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
