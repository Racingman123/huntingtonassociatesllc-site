export type TransactionalEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  templateVersion: string;
};

export type EmailAcceptance = {
  providerMessageId: string;
};

export interface EmailNotificationProvider {
  send(email: TransactionalEmail, idempotencyKey: string): Promise<EmailAcceptance>;
}

export class NotificationDeliveryError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean, options: { cause?: unknown } = {}) {
    super("Transactional email delivery failed", { cause: options.cause });
    this.name = "NotificationDeliveryError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function asNotificationDeliveryError(error: unknown) {
  if (error instanceof NotificationDeliveryError) return error;
  return new NotificationDeliveryError("notification_processing_failed", true, { cause: error });
}
