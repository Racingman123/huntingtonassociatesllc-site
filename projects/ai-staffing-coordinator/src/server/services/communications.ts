import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import twilio from "twilio";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/types.js";

export interface OutboundCallRequest {
  organizationId?: string;
  to: string;
  answerUrl: string;
  statusCallbackUrl: string;
}

export interface OutboundMessageRequest {
  organizationId?: string;
  to: string;
  body: string;
  statusCallbackUrl?: string;
}

export interface ProviderResult {
  id: string;
  status: string;
}

export type MockCommunicationEvent =
  | ({ type: "call"; at: string } & OutboundCallRequest & ProviderResult)
  | ({ type: "sms"; at: string } & OutboundMessageRequest & ProviderResult)
  | { type: "call_cancel"; at: string; id: string; status: string; organizationId?: string };

export interface CommunicationsProvider {
  readonly kind: "twilio" | "mock";
  createCall(request: OutboundCallRequest): Promise<ProviderResult>;
  cancelCall(providerCallId: string, organizationId?: string): Promise<ProviderResult>;
  sendSms(request: OutboundMessageRequest): Promise<ProviderResult>;
  validateWebhook(signature: string | undefined, url: string, params: Record<string, string>): boolean;
  getEvents?(): readonly MockCommunicationEvent[];
}

export interface CommunicationsApp extends FastifyInstance {
  db: Kysely<Database>;
  config: AppConfig;
}

class MockCommunicationsProvider implements CommunicationsProvider {
  readonly kind = "mock" as const;
  readonly #events: MockCommunicationEvent[] = [];

  constructor(private readonly config: AppConfig) {}

  async createCall(request: OutboundCallRequest): Promise<ProviderResult> {
    const result = { id: `mock-call-${randomUUID()}`, status: "queued" };
    this.#events.push({ type: "call", at: new Date().toISOString(), ...request, ...result });
    return result;
  }

  async sendSms(request: OutboundMessageRequest): Promise<ProviderResult> {
    const result = { id: `mock-message-${randomUUID()}`, status: "sent" };
    this.#events.push({ type: "sms", at: new Date().toISOString(), ...request, ...result });
    return result;
  }

  async cancelCall(providerCallId: string, organizationId?: string): Promise<ProviderResult> {
    const result = { id: providerCallId, status: "canceled" };
    this.#events.push({ type: "call_cancel", at: new Date().toISOString(), organizationId, ...result });
    return result;
  }

  validateWebhook(): boolean {
    // The mock has no signature scheme, so provider webhooks are intentionally unavailable in production.
    return this.config.NODE_ENV !== "production";
  }

  getEvents(): readonly MockCommunicationEvent[] {
    return this.#events;
  }
}

class TwilioCommunicationsProvider implements CommunicationsProvider {
  readonly kind = "twilio" as const;
  readonly #client: ReturnType<typeof twilio>;

  constructor(private readonly config: AppConfig) {
    if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN || !config.TWILIO_PHONE_NUMBER) {
      throw new Error("Twilio provider is selected but its credentials or phone number are missing");
    }
    this.#client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
  }

  async createCall(request: OutboundCallRequest): Promise<ProviderResult> {
    const call = await this.#client.calls.create({
      to: request.to,
      from: this.config.TWILIO_PHONE_NUMBER!,
      url: request.answerUrl,
      method: "POST",
      statusCallback: request.statusCallbackUrl,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });
    return { id: call.sid, status: call.status };
  }

  async sendSms(request: OutboundMessageRequest): Promise<ProviderResult> {
    const message = await this.#client.messages.create({
      to: request.to,
      body: request.body,
      ...(this.config.TWILIO_MESSAGING_SERVICE_SID
        ? { messagingServiceSid: this.config.TWILIO_MESSAGING_SERVICE_SID }
        : { from: this.config.TWILIO_PHONE_NUMBER! }),
      ...(request.statusCallbackUrl ? { statusCallback: request.statusCallbackUrl } : {}),
    });
    return { id: message.sid, status: message.status };
  }

  async cancelCall(providerCallId: string): Promise<ProviderResult> {
    try {
      const call = await this.#client.calls(providerCallId).update({ status: "canceled" });
      return { id: call.sid, status: call.status };
    } catch (error) {
      const current = await this.#client.calls(providerCallId).fetch();
      if (["completed", "busy", "failed", "no-answer", "canceled"].includes(current.status)) {
        return { id: current.sid, status: current.status };
      }
      throw error;
    }
  }

  validateWebhook(signature: string | undefined, url: string, params: Record<string, string>): boolean {
    if (!this.config.TWILIO_VALIDATE_WEBHOOKS) return true;
    if (!signature || !this.config.TWILIO_AUTH_TOKEN) return false;
    return twilio.validateRequest(this.config.TWILIO_AUTH_TOKEN, signature, url, params);
  }
}

export function createCommunicationsProvider(config: AppConfig): CommunicationsProvider {
  if (config.PUBLIC_DEMO_MODE && config.COMMUNICATION_PROVIDER !== "mock") {
    throw new Error("Public demo mode cannot initialize a live communications provider");
  }
  return config.COMMUNICATION_PROVIDER === "twilio"
    ? new TwilioCommunicationsProvider(config)
    : new MockCommunicationsProvider(config);
}

const providers = new WeakMap<FastifyInstance, CommunicationsProvider>();

export function getCommunicationsProvider(app: CommunicationsApp): CommunicationsProvider {
  const decorated = (app as CommunicationsApp & { communicationsProvider?: CommunicationsProvider })
    .communicationsProvider;
  if (decorated) return decorated;

  let provider = providers.get(app);
  if (!provider) {
    provider = createCommunicationsProvider(app.config);
    providers.set(app, provider);
  }
  return provider;
}

export function absoluteWebhookUrl(config: AppConfig, path: string): string {
  return new URL(path, config.PUBLIC_BASE_URL.endsWith("/") ? config.PUBLIC_BASE_URL : `${config.PUBLIC_BASE_URL}/`)
    .toString();
}

export function webhookRequestUrl(config: AppConfig, requestUrl: string): string {
  const base = new URL(config.PUBLIC_BASE_URL);
  return `${base.origin}${requestUrl.startsWith("/") ? requestUrl : `/${requestUrl}`}`;
}

export function formParams(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      typeof item === "string" || typeof item === "number" || typeof item === "boolean"
        ? [[key, String(item)]]
        : [],
    ),
  );
}

export function validateProviderWebhook(
  app: CommunicationsApp,
  signature: string | string[] | undefined,
  requestUrl: string,
  body: unknown,
): boolean {
  const header = Array.isArray(signature) ? signature[0] : signature;
  return getCommunicationsProvider(app).validateWebhook(
    header,
    webhookRequestUrl(app.config, requestUrl),
    formParams(body),
  );
}
