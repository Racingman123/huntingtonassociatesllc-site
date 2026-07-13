import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { ResponseFunctionToolCall, ResponseInputItem, Tool } from "openai/resources/responses/responses";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/types.js";
import { acceptAssignment, declineAssignment } from "./scheduling.js";

const DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const acceptArgs = z.object({}).strict();
const declineArgs = z.object({ reason: z.string().max(500).nullable() }).strict();
const callbackArgs = z
  .object({ reason: z.string().max(500).nullable(), preferred_time: z.string().max(200).nullable() })
  .strict();
const availabilityArgs = z
  .object({
    day: z.enum(DAY_NAMES),
    available: z.boolean(),
    start: z.string().nullable(),
    end: z.string().nullable(),
  })
  .strict();

export const voiceTools: Tool[] = [
  {
    type: "function",
    name: "accept_shift",
    description: "Accept only the shift offered in this phone call after the worker clearly agrees.",
    strict: true,
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    type: "function",
    name: "decline_shift",
    description: "Decline only the shift offered in this phone call after the worker clearly declines.",
    strict: true,
    parameters: {
      type: "object",
      properties: { reason: { type: ["string", "null"], description: "Brief reason, or null if none was given." } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "request_callback",
    description: "Record that the worker wants a human scheduler to call them back.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        reason: { type: ["string", "null"] },
        preferred_time: { type: ["string", "null"], description: "The worker's words, not a computed timestamp." },
      },
      required: ["reason", "preferred_time"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "update_availability",
    description:
      "Update one weekday in this worker's profile. Set available false to clear it. Times must be 24-hour HH:MM local time.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        day: { type: "string", enum: DAY_NAMES },
        available: { type: "boolean" },
        start: { type: ["string", "null"] },
        end: { type: ["string", "null"] },
      },
      required: ["day", "available", "start", "end"],
      additionalProperties: false,
    },
  },
];

export interface VoiceAgentContext {
  db: Kysely<Database>;
  config: AppConfig;
  callSessionId: string;
}

export interface VoiceTurnResult {
  reply: string;
  endCall: boolean;
  outcome?: string;
  usedFallback: boolean;
}

interface CallContext {
  callSessionId: string;
  organizationId: string;
  workerId: string;
  assignmentId: string | null;
  shiftId: string | null;
  workerFirstName: string;
  workerTimezone: string;
  role: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  payRateCents: number | null;
  locationName: string | null;
  locationAddress: string | null;
}

interface ToolExecution {
  ok: boolean;
  message: string;
  outcome?: string;
}

function safeJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function loadCallContext(db: Kysely<Database>, callSessionId: string): Promise<CallContext | undefined> {
  const row = await db
    .selectFrom("callSessions as call")
    .innerJoin("workers as worker", (join) =>
      join.onRef("worker.id", "=", "call.workerId").onRef("worker.organizationId", "=", "call.organizationId"),
    )
    .leftJoin("shifts as shift", (join) =>
      join.onRef("shift.id", "=", "call.shiftId").onRef("shift.organizationId", "=", "call.organizationId"),
    )
    .leftJoin("locations as location", (join) =>
      join.onRef("location.id", "=", "shift.locationId").onRef("location.organizationId", "=", "call.organizationId"),
    )
    .select([
      "call.id as callSessionId",
      "call.organizationId",
      "call.workerId",
      "call.assignmentId",
      "call.shiftId",
      "worker.firstName as workerFirstName",
      "worker.timezone as workerTimezone",
      "shift.role",
      "shift.startsAt",
      "shift.endsAt",
      "shift.payRateCents",
      "location.name as locationName",
      "location.address as locationAddress",
    ])
    .where("call.id", "=", callSessionId)
    .executeTakeFirst();
  if (!row) return undefined;
  return row;
}

async function audit(
  trx: Transaction<Database>,
  context: Pick<CallContext, "organizationId" | "workerId" | "callSessionId">,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  await trx
    .insertInto("auditLogs")
    .values({
      id: randomUUID(),
      organizationId: context.organizationId,
      actorType: "worker",
      actorId: context.workerId,
      actorLabel: "Worker via automated voice assistant",
      action,
      entityType,
      entityId,
      metadata,
      ipAddress: null,
    })
    .execute();
}

async function acceptOfferedShift(db: Kysely<Database>, context: CallContext): Promise<ToolExecution> {
  if (!context.assignmentId || !context.shiftId) return { ok: false, message: "There is no shift offer on this call." };
  const result = await acceptAssignment(db, context.organizationId, context.assignmentId, {
    actorType: "worker",
    actorId: context.workerId,
    actorLabel: "Worker via automated voice assistant",
    metadata: { callSessionId: context.callSessionId },
  });
  if (!result.ok) return { ok: false, message: result.message };
  await db.transaction().execute(async (trx) => {
    await trx.updateTable("assignments").set({ source: "voice" }).where("id", "=", context.assignmentId!).execute();
    await trx.updateTable("callSessions").set({ outcome: "accepted" }).where("id", "=", context.callSessionId).execute();
  });
  return { ok: true, outcome: "accepted", message: "The shift is confirmed and now appears on the worker's schedule." };
}

async function declineOfferedShift(
  db: Kysely<Database>,
  context: CallContext,
  reason: string | null,
): Promise<ToolExecution> {
  if (!context.assignmentId) return { ok: false, message: "There is no shift offer on this call." };
  const result = await declineAssignment(db, context.organizationId, context.assignmentId, reason, {
    actorType: "worker",
    actorId: context.workerId,
    actorLabel: "Worker via automated voice assistant",
    metadata: { callSessionId: context.callSessionId },
  });
  if (!result.ok) return { ok: false, message: result.message };
  await db.transaction().execute(async (trx) => {
    await trx.updateTable("assignments").set({ source: "voice" }).where("id", "=", context.assignmentId!).execute();
    await trx.updateTable("callSessions").set({ outcome: "declined" }).where("id", "=", context.callSessionId).execute();
  });
  return { ok: true, outcome: "declined", message: "The shift has been declined." };
}

async function requestCallback(
  db: Kysely<Database>,
  context: CallContext,
  args: z.infer<typeof callbackArgs>,
): Promise<ToolExecution> {
  return db.transaction().execute(async (trx) => {
    const now = new Date();
    await trx
      .updateTable("callSessions")
      .set({ outcome: "callback_requested", updatedAt: now })
      .where("id", "=", context.callSessionId)
      .where("organizationId", "=", context.organizationId)
      .execute();
    await audit(trx, context, "worker.callback_requested", "callSession", context.callSessionId, args);
    return {
      ok: true,
      outcome: "callback_requested",
      message: "A callback request was recorded for the staffing team.",
    };
  });
}

async function updateAvailability(
  db: Kysely<Database>,
  context: CallContext,
  args: z.infer<typeof availabilityArgs>,
): Promise<ToolExecution> {
  if (args.available && (!args.start || !args.end || !timePattern.test(args.start) || !timePattern.test(args.end))) {
    return { ok: false, message: "Availability times must use valid 24-hour HH:MM values." };
  }
  if (args.available && args.start! >= args.end!) {
    return { ok: false, message: "The availability start time must be before the end time." };
  }
  return db.transaction().execute(async (trx) => {
    const worker = await trx
      .selectFrom("workers")
      .select(["id", "availability"])
      .where("id", "=", context.workerId)
      .where("organizationId", "=", context.organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!worker) return { ok: false, message: "The worker profile could not be found." };
    const availability =
      worker.availability && typeof worker.availability === "object" && !Array.isArray(worker.availability)
        ? { ...worker.availability }
        : {};
    availability[args.day] = args.available ? [{ start: args.start!, end: args.end! }] : [];
    await trx
      .updateTable("workers")
      .set({ availability, updatedAt: new Date() })
      .where("id", "=", context.workerId)
      .execute();
    await audit(trx, context, "worker.availability_updated_by_voice", "worker", context.workerId, args);
    return { ok: true, message: `Availability for ${args.day} was updated.` };
  });
}

export async function executeVoiceTool(
  db: Kysely<Database>,
  context: CallContext,
  name: string,
  rawArgs: unknown,
): Promise<ToolExecution> {
  try {
    switch (name) {
      case "accept_shift":
        acceptArgs.parse(rawArgs);
        return await acceptOfferedShift(db, context);
      case "decline_shift": {
        const args = declineArgs.parse(rawArgs);
        return await declineOfferedShift(db, context, args.reason);
      }
      case "request_callback":
        return await requestCallback(db, context, callbackArgs.parse(rawArgs));
      case "update_availability":
        return await updateAvailability(db, context, availabilityArgs.parse(rawArgs));
      default:
        return { ok: false, message: "That action is not available." };
    }
  } catch (error) {
    if (error instanceof z.ZodError) return { ok: false, message: "The requested action had invalid details." };
    return { ok: false, message: error instanceof Error ? error.message : "The action could not be completed." };
  }
}

export async function recordConversationTurn(
  db: Kysely<Database>,
  context: Pick<CallContext, "callSessionId" | "organizationId">,
  speaker: "agent" | "worker" | "system",
  text: string,
  toolName: string | null = null,
  toolPayload: Record<string, unknown> | null = null,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.selectFrom("callSessions").select("id").where("id", "=", context.callSessionId).forUpdate().executeTakeFirst();
    const last = await trx
      .selectFrom("conversationTurns")
      .select(sql<number>`coalesce(max(sequence), 0)::int`.as("sequence"))
      .where("callSessionId", "=", context.callSessionId)
      .executeTakeFirstOrThrow();
    await trx
      .insertInto("conversationTurns")
      .values({
        id: randomUUID(),
        organizationId: context.organizationId,
        callSessionId: context.callSessionId,
        sequence: last.sequence + 1,
        speaker,
        text,
        toolName,
        toolPayload,
      })
      .execute();
  });
}

function formatShift(context: CallContext): string {
  if (!context.startsAt) return "the offered shift";
  const start = new Intl.DateTimeFormat("en-US", {
    timeZone: context.workerTimezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(context.startsAt));
  const end = context.endsAt
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: context.workerTimezone,
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(context.endsAt))
    : null;
  const pay = context.payRateCents == null
    ? ""
    : `, paying $${(context.payRateCents / 100).toFixed(2)} per hour`;
  return `${context.role ?? "staff"} at ${context.locationName ?? "the worksite"} on ${start}${end ? ` until ${end}` : ""}${pay}`;
}

export async function initializeIdentityCheck(
  db: Kysely<Database>,
  callSessionId: string,
  companyName: string,
  disclosure: string,
): Promise<{ prompt: string; context: CallContext }> {
  const context = await loadCallContext(db, callSessionId);
  if (!context) throw new Error("Call session not found");
  const existing = await db
    .selectFrom("conversationTurns")
    .select("id")
    .where("callSessionId", "=", callSessionId)
    .where("toolName", "=", "identity_pending")
    .executeTakeFirst();
  const prompt = `${disclosure} This is ${companyName}. May I speak with ${context.workerFirstName}?`;
  if (!existing) await recordConversationTurn(db, context, "agent", prompt, "identity_pending", null);
  return { prompt, context };
}

function isAffirmativeIdentity(text: string): boolean {
  return /^(?:yes|yeah|yep|speaking|this is (?:him|her|them)|that's me|that is me|1)\b/i.test(text.trim());
}

function isNegativeIdentity(text: string): boolean {
  return /^(?:no|nope|wrong number|not here|they(?:'re| are) not|2)\b/i.test(text.trim());
}

export async function handleIdentityTurn(
  db: Kysely<Database>,
  callSessionId: string,
  speech: string,
): Promise<VoiceTurnResult | null> {
  const context = await loadCallContext(db, callSessionId);
  if (!context) throw new Error("Call session not found");
  const state = await db
    .selectFrom("conversationTurns")
    .select(["toolName", "sequence"])
    .where("callSessionId", "=", callSessionId)
    .where("speaker", "=", "system")
    .where("toolName", "in", ["identity_verified", "identity_failed"])
    .orderBy("sequence", "desc")
    .executeTakeFirst();
  if (state?.toolName === "identity_verified") return null;
  if (state?.toolName === "identity_failed") {
    return { reply: "Thank you. Goodbye.", endCall: true, outcome: "identity_failed", usedFallback: true };
  }
  if (!speech.trim()) {
    const recent = await db
      .selectFrom("conversationTurns")
      .select("text")
      .where("callSessionId", "=", callSessionId)
      .where("speaker", "=", "worker")
      .orderBy("sequence", "desc")
      .limit(3)
      .execute();
    if (recent.length >= 3 && recent.every((turn) => !turn.text.trim())) {
      await recordConversationTurn(db, context, "system", "Identity was not confirmed after three attempts", "identity_failed", {});
      await db.updateTable("callSessions").set({ outcome: "no_response" }).where("id", "=", callSessionId).execute();
      return {
        reply: "I could not confirm who answered, so I will end the call without sharing scheduling details. Goodbye.",
        endCall: true,
        outcome: "no_response",
        usedFallback: true,
      };
    }
  }
  if (isAffirmativeIdentity(speech)) {
    await recordConversationTurn(db, context, "system", "Worker identity verbally confirmed", "identity_verified", {});
    return {
      reply: `Thank you. We have ${formatShift(context)} available. Would you like to accept it? Say yes, no, or callback.`,
      endCall: false,
      usedFallback: true,
    };
  }
  if (isNegativeIdentity(speech)) {
    await recordConversationTurn(db, context, "system", "Identity was not confirmed", "identity_failed", {});
    await db
      .updateTable("callSessions")
      .set({ outcome: "identity_failed", updatedAt: new Date() })
      .where("id", "=", callSessionId)
      .execute();
    return {
      reply: "I am sorry for the interruption. I will not share any scheduling details. Goodbye.",
      endCall: true,
      outcome: "identity_failed",
      usedFallback: true,
    };
  }
  return {
    reply: `Sorry, I need to confirm I reached ${context.workerFirstName}. Please say yes if you are ${context.workerFirstName}, or no if not.`,
    endCall: false,
    usedFallback: true,
  };
}

export function inferVoiceIntent(speech: string): { name: string; args: Record<string, unknown> } | null {
  const normalized = speech.trim().toLowerCase();
  if (/^(?:1|yes|yeah|yep|sure|okay|ok)\b|\b(?:accept|take (?:it|the shift)|sign me up|i can work)\b/.test(normalized)) {
    return { name: "accept_shift", args: {} };
  }
  if (/^(?:2|no|nope)\b|\b(?:decline|can't work|cannot work|not available|pass on)\b/.test(normalized)) {
    return { name: "decline_shift", args: { reason: null } };
  }
  if (/^(?:3)\b|\b(?:call me back|callback|call back|human|scheduler|representative)\b/.test(normalized)) {
    return { name: "request_callback", args: { reason: "Worker requested a callback", preferred_time: null } };
  }
  return null;
}

async function deterministicFallback(
  db: Kysely<Database>,
  context: CallContext,
  speech: string,
): Promise<VoiceTurnResult> {
  const intent = inferVoiceIntent(speech);
  if (!intent) {
    return {
      reply: "Sorry, I did not understand. Please say accept, decline, or callback.",
      endCall: false,
      usedFallback: true,
    };
  }
  const result = await executeVoiceTool(db, context, intent.name, intent.args);
  const endCall = result.ok && ["accept_shift", "decline_shift", "request_callback"].includes(intent.name);
  return {
    reply: result.ok ? `${result.message} Thank you. Goodbye.` : `${result.message} Would you like a scheduler to call you back?`,
    endCall,
    outcome: result.outcome,
    usedFallback: true,
  };
}

function systemPrompt(context: CallContext, config: AppConfig): string {
  return [
    `You are the concise automated phone scheduling assistant for ${config.COMPANY_DISPLAY_NAME}.`,
    `The worker's identity has already been verbally confirmed. The offered shift is ${formatShift(context)}.`,
    ...(context.locationAddress ? [`The worksite address is ${context.locationAddress}.`] : []),
    "Never claim a database change succeeded until the matching tool returns ok=true.",
    "Only discuss scheduling. Do not ask for sensitive personal data. Never reveal another worker's data.",
    "Use accept_shift or decline_shift only after a clear decision. Offer request_callback for ambiguity or a human request.",
    "Keep spoken responses under 45 words. Do not use markdown, URLs, or symbols that sound unnatural aloud.",
  ].join("\n");
}

function openAIClient(config: AppConfig): OpenAI | null {
  // Twilio needs a prompt response quickly; fall back to deterministic intent handling
  // instead of letting SDK retries hold the live call open.
  return config.OPENAI_API_KEY
    ? new OpenAI({ apiKey: config.OPENAI_API_KEY, timeout: 8_000, maxRetries: 0 })
    : null;
}

export async function runVoiceTurn(input: VoiceAgentContext, speech: string): Promise<VoiceTurnResult> {
  const context = await loadCallContext(input.db, input.callSessionId);
  if (!context) throw new Error("Call session not found");

  await recordConversationTurn(input.db, context, "worker", speech);
  const identityResult = await handleIdentityTurn(input.db, input.callSessionId, speech);
  if (identityResult) {
    await recordConversationTurn(input.db, context, "agent", identityResult.reply);
    return identityResult;
  }
  const workerTurnCount = Number(
    (
      await input.db
        .selectFrom("conversationTurns")
        .select((eb) => eb.fn.countAll().as("count"))
        .where("callSessionId", "=", input.callSessionId)
        .where("speaker", "=", "worker")
        .executeTakeFirstOrThrow()
    ).count,
  );
  if (workerTurnCount >= 8) {
    const reply = "We have reached the end of this automated call. Please contact your staffing office if you still need help. Goodbye.";
    await input.db.updateTable("callSessions").set({ outcome: "turn_limit" }).where("id", "=", input.callSessionId).execute();
    await recordConversationTurn(input.db, context, "agent", reply);
    return { reply, endCall: true, outcome: "turn_limit", usedFallback: true };
  }

  const client = openAIClient(input.config);
  if (!client) {
    const result = await deterministicFallback(input.db, context, speech);
    await recordConversationTurn(input.db, context, "agent", result.reply);
    return result;
  }

  const turns = await input.db
    .selectFrom("conversationTurns")
    .select(["speaker", "text"])
    .where("callSessionId", "=", input.callSessionId)
    .where("speaker", "in", ["agent", "worker"])
    .orderBy("sequence", "asc")
    .limit(20)
    .execute();
  let apiInput: ResponseInputItem[] = [
    { role: "developer", content: systemPrompt(context, input.config) },
    ...turns.map((turn) => ({ role: turn.speaker === "agent" ? "assistant" : "user", content: turn.text }) as ResponseInputItem),
  ];

  let lastExecutedTool: ToolExecution | undefined;
  try {
    let outcome: string | undefined;
    for (let loop = 0; loop < 4; loop += 1) {
      const response = await client.responses.create({
        model: input.config.OPENAI_MODEL,
        input: apiInput,
        tools: voiceTools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
        include: ["reasoning.encrypted_content"],
        max_output_tokens: 250,
      });
      const calls = response.output.filter((item): item is ResponseFunctionToolCall => item.type === "function_call");
      if (calls.length === 0) {
        const reply = response.output_text.trim() || "Would you like to accept, decline, or request a callback?";
        await recordConversationTurn(input.db, context, "agent", reply);
        return { reply, endCall: Boolean(outcome), outcome, usedFallback: false };
      }

      const toolOutputs: ResponseInputItem[] = [];
      for (const call of calls) {
        const args = safeJson(call.arguments);
        const result = await executeVoiceTool(input.db, context, call.name, args);
        lastExecutedTool = result;
        if (result.outcome) outcome = result.outcome;
        await recordConversationTurn(input.db, context, "system", result.message, call.name, {
          args,
          result,
        });
        toolOutputs.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
      }
      apiInput = [...apiInput, ...(response.output as ResponseInputItem[]), ...toolOutputs];
    }
    const reply = outcome ? "Your request was recorded. Thank you. Goodbye." : "I will have a scheduler call you back. Goodbye.";
    await recordConversationTurn(input.db, context, "agent", reply);
    return { reply, endCall: true, outcome, usedFallback: false };
  } catch {
    if (lastExecutedTool) {
      const reply = lastExecutedTool.ok
        ? `${lastExecutedTool.message}${lastExecutedTool.outcome ? " Thank you. Goodbye." : " Is there anything else about your schedule?"}`
        : `${lastExecutedTool.message} Would you like a scheduler to call you back?`;
      await recordConversationTurn(input.db, context, "agent", reply);
      return {
        reply,
        endCall: Boolean(lastExecutedTool.outcome),
        outcome: lastExecutedTool.outcome,
        usedFallback: true,
      };
    }
    const result = await deterministicFallback(input.db, context, speech);
    await recordConversationTurn(input.db, context, "agent", result.reply);
    return result;
  }
}

export async function getCallContextForVoice(
  db: Kysely<Database>,
  callSessionId: string,
): Promise<CallContext | undefined> {
  return loadCallContext(db, callSessionId);
}
