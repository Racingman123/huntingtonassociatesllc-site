import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { sql, type Transaction } from "kysely";
import type { Job } from "../db/types.js";
import { evaluateWorkerEligibility, listEligibleWorkers } from "./scheduling.js";
import {
  absoluteWebhookUrl,
  getCommunicationsProvider,
  type CommunicationsApp,
} from "./communications.js";

const DEFAULT_CALL_MAX_ATTEMPTS = 3;
const LOCK_TIMEOUT_MINUTES = 10;

type WorkerConfig = CommunicationsApp["config"] & {
  CONTACT_WINDOW_START_LOCAL?: string | number;
  CONTACT_WINDOW_END_LOCAL?: string | number;
  MAX_CONCURRENT_OUTBOUND_CALLS?: string | number;
};

function localMinute(value: string | number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value <= 24 ? Math.floor(value * 60) : Math.floor(value);
  if (typeof value === "string") {
    if (/^\d{1,2}:\d{2}$/.test(value)) {
      const [hour, minute] = value.split(":").map(Number);
      if (hour! >= 0 && hour! <= 23 && minute! >= 0 && minute! <= 59) return hour! * 60 + minute!;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric <= 24 ? Math.floor(numeric * 60) : Math.floor(numeric);
  }
  return fallback;
}

export function nextAllowedContactAt(config: WorkerConfig, timezone: string, now = new Date()): Date {
  const start = localMinute(config.CONTACT_WINDOW_START_LOCAL, 8 * 60);
  const end = localMinute(config.CONTACT_WINDOW_END_LOCAL, 20 * 60);
  let localNow = DateTime.fromJSDate(now, { zone: timezone });
  if (!localNow.isValid) localNow = DateTime.fromJSDate(now, { zone: config.DEFAULT_TIMEZONE });
  const minute = localNow.hour * 60 + localNow.minute;
  if (minute < start) return localNow.startOf("day").plus({ minutes: start }).toJSDate();
  if (minute >= end) return localNow.plus({ days: 1 }).startOf("day").plus({ minutes: start }).toJSDate();
  return now;
}

export function isContactWindowOpen(config: WorkerConfig, timezone: string, now = new Date()): boolean {
  return nextAllowedContactAt(config, timezone, now).getTime() <= now.getTime();
}

export interface QueueOutboundCallInput {
  organizationId: string;
  workerId: string;
  shiftId: string;
  assignmentId?: string;
}

export async function queueOutboundCall(
  app: CommunicationsApp,
  input: QueueOutboundCallInput,
): Promise<{ callSessionId: string; jobId: string; queuedFor: Date; reused: boolean }> {
  return app.db.transaction().execute(async (trx) => {
    const worker = await trx
      .selectFrom("workers")
      .selectAll()
      .where("id", "=", input.workerId)
      .where("organizationId", "=", input.organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!worker) throw new Error("Worker not found");
    if (worker.status !== "active") throw new Error("Only active workers may be called");
    if (!worker.voiceConsent || worker.doNotCall) throw new Error("Worker has not consented to calls or is on the do-not-call list");

    const shift = await trx
      .selectFrom("shifts")
      .selectAll()
      .where("id", "=", input.shiftId)
      .where("organizationId", "=", input.organizationId)
      .executeTakeFirst();
    if (!shift || shift.status !== "open" || new Date(shift.startsAt).getTime() <= Date.now()) {
      throw new Error("Shift is not open for offers");
    }
    const conflict = await trx
      .selectFrom("assignments as assignment")
      .innerJoin("shifts as acceptedShift", "acceptedShift.id", "assignment.shiftId")
      .select("assignment.id")
      .where("assignment.organizationId", "=", input.organizationId)
      .where("assignment.workerId", "=", worker.id)
      .where("assignment.status", "=", "accepted")
      .where("acceptedShift.startsAt", "<", new Date(shift.endsAt))
      .where("acceptedShift.endsAt", ">", new Date(shift.startsAt))
      .where("acceptedShift.id", "!=", shift.id)
      .executeTakeFirst();
    const eligibility = evaluateWorkerEligibility(worker, shift, { channel: "voice", hasConflict: Boolean(conflict) });
    if (!eligibility.eligible) throw new Error(`Worker is not eligible for this offer: ${eligibility.reasons.join(", ")}`);

    let assignment = input.assignmentId
      ? await trx
          .selectFrom("assignments")
          .selectAll()
          .where("id", "=", input.assignmentId)
          .where("organizationId", "=", input.organizationId)
          .where("workerId", "=", worker.id)
          .where("shiftId", "=", shift.id)
          .executeTakeFirst()
      : await trx
          .selectFrom("assignments")
          .selectAll()
          .where("organizationId", "=", input.organizationId)
          .where("workerId", "=", worker.id)
          .where("shiftId", "=", shift.id)
          .executeTakeFirst();
    if (input.assignmentId && !assignment) throw new Error("Assignment does not match this worker and shift");
    if (!assignment) {
      assignment = await trx
        .insertInto("assignments")
        .values({
          id: randomUUID(),
          organizationId: input.organizationId,
          workerId: worker.id,
          shiftId: shift.id,
          status: "offered",
          offeredAt: new Date(),
          acceptedAt: null,
          declinedAt: null,
          declineReason: null,
          source: "automation",
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } else if (assignment.status === "candidate") {
      assignment = await trx
        .updateTable("assignments")
        .set({ status: "offered", offeredAt: new Date(), updatedAt: new Date() })
        .where("id", "=", assignment.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    } else if (assignment.status !== "offered") {
      throw new Error(`Assignment cannot be offered while it is ${assignment.status}`);
    }

    const existing = await trx
      .selectFrom("callSessions")
      .select("id")
      .where("organizationId", "=", input.organizationId)
      .where("assignmentId", "=", assignment.id)
      .where("status", "in", ["queued", "initiated", "ringing", "in_progress"])
      .orderBy("createdAt", "desc")
      .executeTakeFirst();
    if (existing) {
      const existingJob = await trx
        .selectFrom("jobs")
        .select(["id", "runAt"])
        .where("organizationId", "=", input.organizationId)
        .where("idempotencyKey", "=", `outbound-call:${existing.id}`)
        .executeTakeFirst();
      return {
        callSessionId: existing.id,
        jobId: existingJob?.id ?? "",
        queuedFor: existingJob ? new Date(existingJob.runAt) : new Date(),
        reused: true,
      };
    }

    const callSessionId = randomUUID();
    const jobId = randomUUID();
    const queuedFor = nextAllowedContactAt(app.config as WorkerConfig, worker.timezone);
    const maxAttempts = Number(app.config.MAX_CALL_ATTEMPTS ?? DEFAULT_CALL_MAX_ATTEMPTS);
    await trx
      .insertInto("callSessions")
      .values({
        id: callSessionId,
        organizationId: input.organizationId,
        workerId: worker.id,
        shiftId: shift.id,
        assignmentId: assignment.id,
        providerCallId: null,
        status: "queued",
        direction: "outbound",
        attempt: 0,
        disclosurePlayedAt: null,
        startedAt: null,
        endedAt: null,
        outcome: null,
        errorMessage: null,
      })
      .execute();
    await trx
      .insertInto("jobs")
      .values({
        id: jobId,
        organizationId: input.organizationId,
        type: "outbound_call",
        status: "pending",
        runAt: queuedFor,
        payload: { callSessionId },
        idempotencyKey: `outbound-call:${callSessionId}`,
        attempts: 0,
        maxAttempts: Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : DEFAULT_CALL_MAX_ATTEMPTS,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
        completedAt: null,
      })
      .execute();
    return { callSessionId, jobId, queuedFor, reused: false };
  });
}

async function enqueueUpcomingReminders(app: CommunicationsApp, now = new Date()): Promise<number> {
  const offsets = app.config.reminderOffsetsMinutes;
  if (offsets.length === 0) return 0;
  const latest = new Date(now.getTime() + Math.max(...offsets) * 60_000 + 60 * 60_000);
  const assignments = await app.db
    .selectFrom("assignments as assignment")
    .innerJoin("shifts as shift", (join) =>
      join.onRef("shift.id", "=", "assignment.shiftId").onRef("shift.organizationId", "=", "assignment.organizationId"),
    )
    .select(["assignment.id", "assignment.organizationId", "shift.startsAt"])
    .where("assignment.status", "=", "accepted")
    .where("shift.status", "in", ["open", "filled"])
    .where("shift.startsAt", ">", now)
    .where("shift.startsAt", "<=", latest)
    .execute();
  let inserted = 0;
  for (const assignment of assignments) {
    for (const offsetMinutes of offsets) {
      const target = new Date(new Date(assignment.startsAt).getTime() - offsetMinutes * 60_000);
      if (target.getTime() < now.getTime()) continue;
      const result = await app.db
        .insertInto("jobs")
        .values({
          id: randomUUID(),
          organizationId: assignment.organizationId,
          type: "shift_reminder",
          status: "pending",
          runAt: target,
          payload: { assignmentId: assignment.id, offsetMinutes },
          idempotencyKey: `shift-reminder:${assignment.id}:${offsetMinutes}`,
          attempts: 0,
          maxAttempts: 5,
          lockedAt: null,
          lockedBy: null,
          lastError: null,
          completedAt: null,
        })
        .onConflict((conflict) => conflict.columns(["organizationId", "idempotencyKey"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (result) inserted += 1;
    }
  }
  return inserted;
}

async function claimJob(app: CommunicationsApp, workerId: string, organizationId?: string): Promise<Job | undefined> {
  return app.db.transaction().execute(async (trx) => {
    let query = trx
      .selectFrom("jobs")
      .selectAll()
      .where("status", "=", "pending")
      .where("runAt", "<=", new Date());
    if (organizationId) query = query.where("organizationId", "=", organizationId);
    const job = await query
      .orderBy("runAt", "asc")
      .forUpdate()
      .skipLocked()
      .limit(1)
      .executeTakeFirst();
    if (!job) return undefined;
    return trx
      .updateTable("jobs")
      .set({
        status: "processing",
        lockedAt: new Date(),
        lockedBy: workerId,
        attempts: sql`attempts + 1`,
        updatedAt: new Date(),
      })
      .where("id", "=", job.id)
      .returningAll()
      .executeTakeFirst();
  });
}

async function completeJob(app: CommunicationsApp, job: Job): Promise<void> {
  await app.db
    .updateTable("jobs")
    .set({
      status: "completed",
      completedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where("id", "=", job.id)
    .execute();
}

async function failOrRetryJob(app: CommunicationsApp, job: Job, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
  const exhausted = job.attempts >= job.maxAttempts;
  const backoffMinutes = Math.min(60, 2 ** Math.max(0, job.attempts - 1));
  await app.db
    .updateTable("jobs")
    .set({
      status: exhausted ? "failed" : "pending",
      runAt: exhausted ? new Date(job.runAt) : new Date(Date.now() + backoffMinutes * 60_000),
      lockedAt: null,
      lockedBy: null,
      lastError: message,
      updatedAt: new Date(),
    })
    .where("id", "=", job.id)
    .execute();
}

function payloadId(job: Job, key: string): string {
  const value = job.payload?.[key];
  if (typeof value !== "string" || !value) throw new Error(`Job payload is missing ${key}`);
  return value;
}

async function insertSuppressedMessage(
  trx: Transaction<import("../db/types.js").Database>,
  job: Job,
  workerId: string,
  assignmentId: string,
  body: string,
  reason: string,
): Promise<void> {
  await trx
    .insertInto("messages")
    .values({
      id: randomUUID(),
      organizationId: job.organizationId,
      workerId,
      assignmentId,
      providerMessageId: null,
      direction: "outbound",
      channel: "sms",
      body,
      status: "suppressed",
      idempotencyKey: job.idempotencyKey,
      errorMessage: reason,
      sentAt: null,
      deliveredAt: null,
    })
    .onConflict((conflict) =>
      conflict.columns(["organizationId", "idempotencyKey"]).where("idempotencyKey", "is not", null).doNothing(),
    )
    .execute();
}

async function sendShiftReminder(app: CommunicationsApp, job: Job): Promise<void> {
  const assignmentId = payloadId(job, "assignmentId");
  const row = await app.db
    .selectFrom("assignments as assignment")
    .innerJoin("workers as worker", (join) =>
      join.onRef("worker.id", "=", "assignment.workerId").onRef("worker.organizationId", "=", "assignment.organizationId"),
    )
    .innerJoin("shifts as shift", (join) =>
      join.onRef("shift.id", "=", "assignment.shiftId").onRef("shift.organizationId", "=", "assignment.organizationId"),
    )
    .innerJoin("locations as location", (join) =>
      join.onRef("location.id", "=", "shift.locationId").onRef("location.organizationId", "=", "assignment.organizationId"),
    )
    .select([
      "assignment.id as assignmentId",
      "assignment.status as assignmentStatus",
      "worker.id as workerId",
      "worker.phone",
      "worker.timezone",
      "worker.smsConsent",
      "worker.doNotText",
      "worker.status as workerStatus",
      "shift.role",
      "shift.startsAt",
      "shift.status as shiftStatus",
      "location.name as locationName",
    ])
    .where("assignment.id", "=", assignmentId)
    .where("assignment.organizationId", "=", job.organizationId)
    .executeTakeFirst();
  if (!row) throw new Error("Reminder assignment not found");
  if (row.assignmentStatus !== "accepted" || !["open", "filled"].includes(row.shiftStatus)) return;
  if (new Date(row.startsAt).getTime() <= Date.now()) return;

  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: row.timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(row.startsAt));
  const body = `${app.config.COMPANY_DISPLAY_NAME}: Reminder—your ${row.role} shift at ${row.locationName} starts ${when}. Reply STOP to opt out.`;

  if (row.workerStatus !== "active" || !row.smsConsent || row.doNotText) {
    await app.db.transaction().execute((trx) =>
      insertSuppressedMessage(
        trx,
        job,
        row.workerId,
        row.assignmentId,
        body,
        "Worker is inactive, has not consented to SMS, or opted out",
      ),
    );
    return;
  }
  const nextWindow = nextAllowedContactAt(app.config as WorkerConfig, row.timezone);
  if (nextWindow.getTime() > Date.now()) {
    await app.db
      .updateTable("jobs")
      .set({ status: "pending", runAt: nextWindow, lockedAt: null, lockedBy: null, updatedAt: new Date() })
      .where("id", "=", job.id)
      .execute();
    return;
  }

  const message = await app.db.transaction().execute(async (trx) => {
    await trx
      .insertInto("messages")
      .values({
        id: randomUUID(),
        organizationId: job.organizationId,
        workerId: row.workerId,
        assignmentId: row.assignmentId,
        providerMessageId: null,
        direction: "outbound",
        channel: "sms",
        body,
        status: "queued",
        idempotencyKey: job.idempotencyKey,
        errorMessage: null,
        sentAt: null,
        deliveredAt: null,
      })
      .onConflict((conflict) =>
        conflict.columns(["organizationId", "idempotencyKey"]).where("idempotencyKey", "is not", null).doNothing(),
      )
      .execute();
    return trx
      .selectFrom("messages")
      .selectAll()
      .where("organizationId", "=", job.organizationId)
      .where("idempotencyKey", "=", job.idempotencyKey)
      .forUpdate()
      .executeTakeFirstOrThrow();
  });
  if (["sent", "delivered", "suppressed"].includes(message.status)) return;

  try {
    const sent = await getCommunicationsProvider(app).sendSms({
      organizationId: job.organizationId,
      to: row.phone,
      body,
      statusCallbackUrl: absoluteWebhookUrl(app.config, "/webhooks/twilio/messages/status"),
    });
    await app.db
      .updateTable("messages")
      .set({
        providerMessageId: sent.id,
        status: sent.status === "delivered" ? "delivered" : "sent",
        sentAt: new Date(),
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where("id", "=", message.id)
      .execute();
  } catch (error) {
    await app.db
      .updateTable("messages")
      .set({ status: "failed", errorMessage: error instanceof Error ? error.message : String(error), updatedAt: new Date() })
      .where("id", "=", message.id)
      .execute();
    throw error;
  }
}

async function placeOutboundCall(app: CommunicationsApp, job: Job): Promise<void> {
  const callSessionId = payloadId(job, "callSessionId");
  const row = await app.db
    .selectFrom("callSessions as call")
    .innerJoin("workers as worker", (join) =>
      join.onRef("worker.id", "=", "call.workerId").onRef("worker.organizationId", "=", "call.organizationId"),
    )
    .innerJoin("shifts as shift", (join) =>
      join.onRef("shift.id", "=", "call.shiftId").onRef("shift.organizationId", "=", "call.organizationId"),
    )
    .leftJoin("assignments as assignment", (join) =>
      join.onRef("assignment.id", "=", "call.assignmentId").onRef("assignment.organizationId", "=", "call.organizationId"),
    )
    .select([
      "call.id",
      "call.status",
      "call.attempt",
      "call.providerCallId",
      "call.workerId",
      "worker.phone",
      "worker.timezone",
      "worker.voiceConsent",
      "worker.doNotCall",
      "worker.status as workerStatus",
      "shift.id as shiftId",
      "shift.status as shiftStatus",
      "shift.startsAt as shiftStartsAt",
      "shift.headcount",
      "assignment.status as assignmentStatus",
    ])
    .where("call.id", "=", callSessionId)
    .where("call.organizationId", "=", job.organizationId)
    .executeTakeFirst();
  if (!row) throw new Error("Call session not found");
  if (["completed", "cancelled", "in_progress", "ringing"].includes(row.status) || row.providerCallId) return;
  if (row.workerStatus !== "active" || !row.voiceConsent || row.doNotCall) {
    await app.db
      .updateTable("callSessions")
      .set({ status: "cancelled", outcome: "suppressed", errorMessage: "Worker is not callable", endedAt: new Date(), updatedAt: new Date() })
      .where("id", "=", row.id)
      .execute();
    return;
  }
  const acceptedCount = Number(
    (
      await app.db
        .selectFrom("assignments")
        .select((eb) => eb.fn.countAll().as("count"))
        .where("organizationId", "=", job.organizationId)
        .where("shiftId", "=", row.shiftId)
        .where("status", "=", "accepted")
        .executeTakeFirstOrThrow()
    ).count,
  );
  if (
    row.shiftStatus !== "open" ||
    new Date(row.shiftStartsAt).getTime() <= Date.now() ||
    !["candidate", "offered"].includes(row.assignmentStatus ?? "") ||
    acceptedCount >= row.headcount
  ) {
    await app.db
      .updateTable("callSessions")
      .set({
        status: "cancelled",
        outcome: "shift_unavailable",
        errorMessage: "Shift was closed, full, started, or the offer was resolved before dialing",
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where("id", "=", row.id)
      .execute();
    return;
  }
  const nextWindow = nextAllowedContactAt(app.config as WorkerConfig, row.timezone);
  if (nextWindow.getTime() > Date.now()) {
    await app.db
      .updateTable("jobs")
      .set({ status: "pending", runAt: nextWindow, lockedAt: null, lockedBy: null, updatedAt: new Date() })
      .where("id", "=", job.id)
      .execute();
    return;
  }
  try {
    const result = await getCommunicationsProvider(app).createCall({
      organizationId: job.organizationId,
      to: row.phone,
      answerUrl: absoluteWebhookUrl(app.config, `/webhooks/twilio/voice/${row.id}`),
      statusCallbackUrl: absoluteWebhookUrl(app.config, `/webhooks/twilio/calls/status/${row.id}`),
    });
    await app.db
      .updateTable("callSessions")
      .set({ providerCallId: result.id, status: "initiated", attempt: job.attempts, startedAt: new Date(), errorMessage: null, updatedAt: new Date() })
      .where("id", "=", row.id)
      .execute();
    await app.db
      .updateTable("workers")
      .set({ lastContactedAt: new Date(), updatedAt: new Date() })
      .where("id", "=", row.workerId)
      .execute();
  } catch (error) {
    await app.db
      .updateTable("callSessions")
      .set({ status: "failed", attempt: job.attempts, errorMessage: error instanceof Error ? error.message : String(error), updatedAt: new Date() })
      .where("id", "=", row.id)
      .execute();
    throw error;
  }
}

export async function enqueueCampaignTick(
  app: CommunicationsApp,
  organizationId: string,
  shiftId: string,
  idempotencySuffix: string,
  runAt = new Date(),
): Promise<boolean> {
  const inserted = await app.db
    .insertInto("jobs")
    .values({
      id: randomUUID(),
      organizationId,
      type: "campaign_tick",
      status: "pending",
      runAt,
      payload: { shiftId },
      idempotencyKey: `autofill:${shiftId}:${idempotencySuffix}`,
      attempts: 0,
      maxAttempts: 5,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      completedAt: null,
    })
    .onConflict((conflict) => conflict.columns(["organizationId", "idempotencyKey"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  return Boolean(inserted);
}

async function runCampaignTick(app: CommunicationsApp, job: Job): Promise<void> {
  const shiftId = payloadId(job, "shiftId");
  const shift = await app.db
    .selectFrom("shifts")
    .selectAll()
    .where("id", "=", shiftId)
    .where("organizationId", "=", job.organizationId)
    .executeTakeFirst();
  if (!shift || !shift.autoFillEnabled || shift.status !== "open" || new Date(shift.startsAt).getTime() <= Date.now()) return;

  const accepted = Number(
    (
      await app.db
        .selectFrom("assignments")
        .select((eb) => eb.fn.countAll().as("count"))
        .where("organizationId", "=", job.organizationId)
        .where("shiftId", "=", shiftId)
        .where("status", "=", "accepted")
        .executeTakeFirstOrThrow()
    ).count,
  );
  const remainingSeats = Math.max(0, shift.headcount - accepted);
  if (remainingSeats === 0) return;

  const activeStatuses = ["queued", "initiated", "ringing", "in_progress"] as const;
  const activeForShift = Number(
    (
      await app.db
        .selectFrom("callSessions")
        .select((eb) => eb.fn.countAll().as("count"))
        .where("organizationId", "=", job.organizationId)
        .where("shiftId", "=", shiftId)
        .where("status", "in", activeStatuses)
        .executeTakeFirstOrThrow()
    ).count,
  );
  const activeForOrganization = Number(
    (
      await app.db
        .selectFrom("callSessions")
        .select((eb) => eb.fn.countAll().as("count"))
        .where("organizationId", "=", job.organizationId)
        .where("status", "in", activeStatuses)
        .executeTakeFirstOrThrow()
    ).count,
  );
  const configuredConcurrency = Number((app.config as WorkerConfig).MAX_CONCURRENT_OUTBOUND_CALLS ?? 5);
  const maxConcurrency = Number.isInteger(configuredConcurrency) && configuredConcurrency > 0 ? configuredConcurrency : 5;
  const offersNeeded = Math.min(
    Math.max(0, remainingSeats - activeForShift),
    Math.max(0, maxConcurrency - activeForOrganization),
  );
  if (offersNeeded === 0) return;

  const eligibility = await listEligibleWorkers(app.db, job.organizationId, shiftId, {
    channel: "voice",
    limit: Math.min(200, offersNeeded * 10),
  });
  if (!eligibility) return;
  const contacted = await app.db
    .selectFrom("callSessions")
    .select("workerId")
    .where("organizationId", "=", job.organizationId)
    .where("shiftId", "=", shiftId)
    .execute();
  const resolvedAssignments = await app.db
    .selectFrom("assignments")
    .select("workerId")
    .where("organizationId", "=", job.organizationId)
    .where("shiftId", "=", shiftId)
    .where("status", "in", ["accepted", "declined"])
    .execute();
  const excluded = new Set([...contacted, ...resolvedAssignments].map((row) => row.workerId));

  let queued = 0;
  for (const candidate of eligibility.workers) {
    if (queued >= offersNeeded) break;
    if (excluded.has(candidate.worker.id)) continue;
    try {
      await queueOutboundCall(app, {
        organizationId: job.organizationId,
        workerId: candidate.worker.id,
        shiftId,
      });
      excluded.add(candidate.worker.id);
      queued += 1;
    } catch (error) {
      app.log.warn({ err: error, workerId: candidate.worker.id, shiftId }, "Auto-fill candidate was skipped");
    }
  }
}

async function executeJob(app: CommunicationsApp, job: Job): Promise<void> {
  if (job.type === "shift_reminder") return sendShiftReminder(app, job);
  if (job.type === "outbound_call") return placeOutboundCall(app, job);
  if (job.type === "campaign_tick") return runCampaignTick(app, job);
  const exhaustive: never = job.type;
  throw new Error(`Unsupported job type: ${exhaustive}`);
}

export async function processReminderJobsOnce(
  app: CommunicationsApp,
  limit = 10,
  organizationId?: string,
): Promise<number> {
  const workerId = `scheduler-${process.pid}-${randomUUID()}`;
  let processed = 0;
  for (; processed < limit; processed += 1) {
    const job = await claimJob(app, workerId, organizationId);
    if (!job) break;
    try {
      await executeJob(app, job);
      const current = await app.db.selectFrom("jobs").select("status").where("id", "=", job.id).executeTakeFirst();
      if (current?.status === "processing") await completeJob(app, job);
    } catch (error) {
      await failOrRetryJob(app, job, error);
    }
  }
  return processed;
}

async function releaseStaleLocks(app: CommunicationsApp): Promise<void> {
  const stale = new Date(Date.now() - LOCK_TIMEOUT_MINUTES * 60_000);
  await app.db
    .updateTable("jobs")
    .set({ status: "pending", lockedAt: null, lockedBy: null, updatedAt: new Date(), lastError: "Recovered stale worker lock" })
    .where("status", "=", "processing")
    .where("lockedAt", "<", stale)
    .execute();
}

export function startReminderWorker(app: CommunicationsApp): () => Promise<void> {
  if (!app.config.SCHEDULER_ENABLED) return async () => undefined;
  let stopped = false;
  let running: Promise<void> | null = null;
  const tick = async () => {
    if (stopped || running) return;
    running = (async () => {
      try {
        await releaseStaleLocks(app);
        await enqueueUpcomingReminders(app);
        await processReminderJobsOnce(app);
      } catch (error) {
        app.log.error({ err: error }, "Reminder worker tick failed");
      }
    })().finally(() => {
      running = null;
    });
    await running;
  };
  const timer = setInterval(() => void tick(), app.config.SCHEDULER_INTERVAL_MS);
  timer.unref();
  void tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
