import { z } from "zod";
import {
  NotificationDeliveryError,
  type EmailNotificationProvider,
  type TransactionalEmail,
} from "./email";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 10_000;
const emailAddress = z.email();

export type ResendConfig = {
  apiKey: string;
  from: string;
};

export type ResendEnvironment = {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
};

function runtimeEnvironment(): ResendEnvironment {
  return {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
  };
}

function senderAddress(value: string) {
  const friendlyAddress = value.match(/<([^<>]+)>\s*$/)?.[1];
  return (friendlyAddress ?? value).trim();
}

function validConfig(config: ResendConfig) {
  return config.apiKey.trim().length >= 8
    && !/replace-with/i.test(config.apiKey)
    && config.from.trim().length > 0
    && config.from.length <= 320
    && !/[\u0000-\u001f\u007f]/.test(config.from)
    && emailAddress.safeParse(senderAddress(config.from)).success;
}

/** Returns null when delivery should remain disabled. */
export function getResendConfig(environment: ResendEnvironment = runtimeEnvironment()): ResendConfig | null {
  const config = {
    apiKey: environment.RESEND_API_KEY?.trim() ?? "",
    from: environment.EMAIL_FROM?.trim() ?? "",
  };
  if (!validConfig(config) || /@example\./i.test(config.from)) return null;
  return config;
}

export function isResendConfigured(environment: ResendEnvironment = runtimeEnvironment()) {
  return getResendConfig(environment) !== null;
}

function safeProviderCode(value: unknown) {
  if (typeof value !== "string" || !/^[a-z0-9_]{1,80}$/i.test(value)) return null;
  return value.toLowerCase();
}

function isRetryableResponse(status: number, providerCode: string | null) {
  if (status === 409) return providerCode === "concurrent_idempotent_requests";
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sanitizeSubject(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

export class ResendEmailProvider implements EmailNotificationProvider {
  constructor(
    private readonly config: ResendConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    if (!validConfig(config)) {
      throw new NotificationDeliveryError("email_provider_not_configured", false);
    }
  }

  async send(email: TransactionalEmail, idempotencyKey: string) {
    if (!emailAddress.safeParse(email.to).success) {
      throw new NotificationDeliveryError("recipient_address_invalid", false);
    }
    if (!emailAddress.safeParse(email.replyTo ?? email.to).success) {
      throw new NotificationDeliveryError("reply_address_invalid", false);
    }
    if (!idempotencyKey || idempotencyKey.length > 256) {
      throw new NotificationDeliveryError("provider_idempotency_key_invalid", false);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImplementation(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [email.to],
          subject: sanitizeSubject(email.subject),
          html: email.html,
          text: email.text,
          reply_to: email.replyTo,
          tags: [
            { name: "channel", value: "transactional" },
            { name: "template_version", value: email.templateVersion },
          ],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new NotificationDeliveryError("email_provider_unavailable", true, { cause: error });
    } finally {
      clearTimeout(timeout);
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      responseBody = null;
    }
    const body = typeof responseBody === "object" && responseBody !== null
      ? responseBody as Record<string, unknown>
      : {};
    const providerCode = safeProviderCode(body.name) ?? safeProviderCode(body.type);

    if (!response.ok) {
      const code = providerCode ? `resend_${providerCode}` : `resend_http_${response.status}`;
      throw new NotificationDeliveryError(code, isRetryableResponse(response.status, providerCode));
    }
    if (typeof body.id !== "string" || !body.id.trim()) {
      throw new NotificationDeliveryError("email_provider_response_invalid", true);
    }
    return { providerMessageId: body.id };
  }
}

export function createResendEmailProvider(
  environment: ResendEnvironment = runtimeEnvironment(),
  fetchImplementation: typeof fetch = fetch,
) {
  const config = getResendConfig(environment);
  if (!config) throw new NotificationDeliveryError("email_provider_not_configured", false);
  return new ResendEmailProvider(config, fetchImplementation);
}
