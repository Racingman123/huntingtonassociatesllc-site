import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import twilio from "twilio";
import { z } from "zod";
import {
  formParams,
  validateProviderWebhook,
  type CommunicationsApp,
} from "../services/communications.js";
import { enqueueCampaignTick } from "../services/reminder-worker.js";
import { writeAuditLog } from "../services/audit.js";
import {
  initializeIdentityCheck,
  recordConversationTurn,
  runVoiceTurn,
} from "../services/voice-agent.js";

const callParams = z.object({ callSessionId: z.string().min(1) });

function signatureHeader(request: FastifyRequest): string | string[] | undefined {
  const signature = request.headers["x-twilio-signature"];
  return typeof signature === "number" ? String(signature) : signature;
}

function requireValidWebhook(app: CommunicationsApp, request: FastifyRequest, reply: FastifyReply): boolean {
  if (!validateProviderWebhook(app, signatureHeader(request), request.url, request.body)) {
    void reply.code(403).send({ error: "invalid_signature", message: "Webhook signature is invalid" });
    return false;
  }
  return true;
}

export function buildVoiceTwiml(prompt: string, actionUrl: string, endCall = false): string {
  const response = new twilio.twiml.VoiceResponse();
  if (endCall) {
    response.say({ voice: "Polly.Joanna" }, prompt);
    response.hangup();
    return response.toString();
  }
  const gather = response.gather({
    input: ["speech", "dtmf"],
    numDigits: 1,
    action: actionUrl,
    method: "POST",
    speechTimeout: "auto",
    timeout: 6,
    actionOnEmptyResult: true,
  });
  gather.say({ voice: "Polly.Joanna" }, prompt);
  return response.toString();
}

function xml(reply: FastifyReply, body: string): FastifyReply {
  return reply.type("text/xml; charset=utf-8").send(body);
}

function normalizeCallStatus(status: string):
  | "queued"
  | "initiated"
  | "ringing"
  | "in_progress"
  | "completed"
  | "busy"
  | "failed"
  | "no_answer"
  | "cancelled"
  | null {
  switch (status.toLowerCase()) {
    case "queued":
      return "queued";
    case "initiated":
      return "initiated";
    case "ringing":
      return "ringing";
    case "answered":
    case "in-progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "busy":
      return "busy";
    case "failed":
      return "failed";
    case "no-answer":
      return "no_answer";
    case "canceled":
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

function terminalCallStatus(status: string): boolean {
  return ["completed", "busy", "failed", "no_answer", "cancelled"].includes(status);
}

function smsKeyword(body: string, optOutType?: string): "STOP" | "START" | "HELP" | null {
  const normalizedType = optOutType?.trim().toUpperCase();
  if (normalizedType === "STOP" || normalizedType === "START" || normalizedType === "HELP") return normalizedType;
  const normalized = body.trim().toUpperCase();
  if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(normalized)) return "STOP";
  if (["START", "UNSTOP", "YES"].includes(normalized)) return "START";
  if (["HELP", "INFO"].includes(normalized)) return "HELP";
  return null;
}

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.post("/webhooks/twilio/voice/:callSessionId", async (request, reply) => {
    if (!requireValidWebhook(app, request, reply)) return;
    const { callSessionId } = callParams.parse(request.params);
    try {
      const { prompt, context } = await initializeIdentityCheck(
        app.db,
        callSessionId,
        app.config.COMPANY_DISPLAY_NAME,
        app.config.AGENT_DISCLOSURE,
      );
      const now = new Date();
      await app.db
        .updateTable("callSessions")
        .set({ status: "in_progress", disclosurePlayedAt: now, startedAt: now, updatedAt: now })
        .where("id", "=", callSessionId)
        .where("organizationId", "=", context.organizationId)
        .execute();
      return xml(reply, buildVoiceTwiml(prompt, `/webhooks/twilio/voice/${callSessionId}/turn`));
    } catch {
      return xml(reply, buildVoiceTwiml("We cannot complete this scheduling call right now. Goodbye.", "", true));
    }
  });

  app.post("/webhooks/twilio/voice/:callSessionId/turn", async (request, reply) => {
    if (!requireValidWebhook(app, request, reply)) return;
    const { callSessionId } = callParams.parse(request.params);
    const body = formParams(request.body);
    const speech = (body.SpeechResult || body.Digits || "").trim();
    try {
      const result = await runVoiceTurn({ db: app.db, config: app.config, callSessionId }, speech);
      if (result.endCall) {
        await app.db
          .updateTable("callSessions")
          .set({ endedAt: new Date(), updatedAt: new Date(), ...(result.outcome ? { outcome: result.outcome } : {}) })
          .where("id", "=", callSessionId)
          .execute();
      }
      return xml(
        reply,
        buildVoiceTwiml(result.reply, `/webhooks/twilio/voice/${callSessionId}/turn`, result.endCall),
      );
    } catch {
      return xml(reply, buildVoiceTwiml("I am sorry, the scheduling service is unavailable. Please contact your scheduler. Goodbye.", "", true));
    }
  });

  app.post("/webhooks/twilio/calls/status/:callSessionId", async (request, reply) => {
    if (!requireValidWebhook(app, request, reply)) return;
    const { callSessionId } = callParams.parse(request.params);
    const body = formParams(request.body);
    const status = normalizeCallStatus(body.CallStatus ?? "");
    if (status) {
      const now = new Date();
      await app.db
        .updateTable("callSessions")
        .set({
          status,
          ...(body.CallSid ? { providerCallId: body.CallSid } : {}),
          ...(status === "in_progress" ? { startedAt: now } : {}),
          ...(terminalCallStatus(status) ? { endedAt: now } : {}),
          ...(body.ErrorMessage ? { errorMessage: body.ErrorMessage.slice(0, 2_000) } : {}),
          updatedAt: now,
        })
        .where("id", "=", callSessionId)
        .execute();
      if (terminalCallStatus(status)) {
        const campaign = await app.db
          .selectFrom("callSessions as call")
          .innerJoin("shifts as shift", (join) =>
            join.onRef("shift.id", "=", "call.shiftId").onRef("shift.organizationId", "=", "call.organizationId"),
          )
          .select(["call.organizationId", "call.shiftId", "shift.status", "shift.autoFillEnabled", "shift.startsAt"])
          .where("call.id", "=", callSessionId)
          .executeTakeFirst();
        if (
          campaign?.shiftId &&
          campaign.autoFillEnabled &&
          campaign.status === "open" &&
          new Date(campaign.startsAt).getTime() > Date.now()
        ) {
          await enqueueCampaignTick(app, campaign.organizationId, campaign.shiftId, `terminal:${callSessionId}`);
        }
      }
    }
    return reply.code(204).send();
  });

  app.post("/webhooks/twilio/messages/status", async (request, reply) => {
    if (!requireValidWebhook(app, request, reply)) return;
    const body = formParams(request.body);
    const sid = body.MessageSid;
    if (sid) {
      const providerStatus = (body.MessageStatus ?? "").toLowerCase();
      const status = providerStatus === "delivered" ? "delivered" : ["failed", "undelivered"].includes(providerStatus) ? "failed" : "sent";
      await app.db
        .updateTable("messages")
        .set({
          status,
          ...(status === "delivered" ? { deliveredAt: new Date() } : {}),
          ...(status === "failed" ? { errorMessage: body.ErrorMessage ?? body.ErrorCode ?? "Provider delivery failure" } : {}),
          updatedAt: new Date(),
        })
        .where("providerMessageId", "=", sid)
        .execute();
    }
    return reply.code(204).send();
  });

  app.post("/webhooks/twilio/sms", async (request, reply) => {
    if (!requireValidWebhook(app, request, reply)) return;
    const body = formParams(request.body);
    const from = body.From;
    const incoming = body.Body ?? "";
    const response = new twilio.twiml.MessagingResponse();
    if (!from) {
      response.message(`${app.config.COMPANY_DISPLAY_NAME}: We could not identify your number. Contact your staffing office for help.`);
      return xml(reply, response.toString());
    }

    const workers = await app.db.selectFrom("workers").selectAll().where("phone", "=", from).limit(2).execute();
    if (workers.length !== 1) {
      response.message(`${app.config.COMPANY_DISPLAY_NAME}: Contact your staffing office for scheduling help.`);
      return xml(reply, response.toString());
    }
    const worker = workers[0]!;
    const keyword = smsKeyword(incoming, body.OptOutType);
    const providerManagedOptOut = Boolean(body.OptOutType && keyword);
    const now = new Date();
    if (keyword === "STOP") {
      await app.db
        .updateTable("workers")
        .set({ smsConsent: false, doNotText: true, updatedAt: now })
        .where("id", "=", worker.id)
        .where("organizationId", "=", worker.organizationId)
        .execute();
      await writeAuditLog(app.db, {
        organizationId: worker.organizationId,
        actorType: "provider",
        actorId: body.MessageSid ?? null,
        actorLabel: "Inbound SMS preference webhook",
        action: "worker.sms_opted_out",
        entityType: "worker",
        entityId: worker.id,
        metadata: { keyword: "STOP", providerManaged: providerManagedOptOut },
      });
      if (!providerManagedOptOut) {
        response.message(`${app.config.COMPANY_DISPLAY_NAME}: You are opted out and will receive no more texts. Reply START to opt back in.`);
      }
    } else if (keyword === "START") {
      await app.db
        .updateTable("workers")
        .set({ smsConsent: true, smsConsentAt: now, smsConsentSource: "inbound_sms_start", doNotText: false, updatedAt: now })
        .where("id", "=", worker.id)
        .where("organizationId", "=", worker.organizationId)
        .execute();
      await writeAuditLog(app.db, {
        organizationId: worker.organizationId,
        actorType: "provider",
        actorId: body.MessageSid ?? null,
        actorLabel: "Inbound SMS preference webhook",
        action: "worker.sms_opted_in",
        entityType: "worker",
        entityId: worker.id,
        metadata: { keyword: "START", providerManaged: providerManagedOptOut },
      });
      if (!providerManagedOptOut) {
        response.message(`${app.config.COMPANY_DISPLAY_NAME}: Text reminders are enabled. Reply STOP to opt out, or HELP for help.`);
      }
    } else if (keyword === "HELP") {
      if (!providerManagedOptOut) {
        response.message(`${app.config.COMPANY_DISPLAY_NAME}: Contact your staffing office for help. Reply STOP to opt out.`);
      }
    } else {
      response.message(`${app.config.COMPANY_DISPLAY_NAME}: This number handles reminder preferences. Reply HELP for help or STOP to opt out.`);
    }

    await app.db
      .insertInto("messages")
      .values({
        id: randomUUID(),
        organizationId: worker.organizationId,
        workerId: worker.id,
        assignmentId: null,
        providerMessageId: body.MessageSid ?? null,
        direction: "inbound",
        channel: "sms",
        body: incoming,
        status: "received",
        idempotencyKey: body.MessageSid ? `inbound:${body.MessageSid}` : null,
        errorMessage: null,
        sentAt: now,
        deliveredAt: now,
      })
      .onConflict((conflict) =>
        conflict.columns(["organizationId", "idempotencyKey"]).where("idempotencyKey", "is not", null).doNothing(),
      )
      .execute();
    return xml(reply, response.toString());
  });
};
