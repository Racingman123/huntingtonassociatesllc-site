import { DateTime } from "luxon";
import { nanoid } from "nanoid";
import { type Kysely, type Transaction } from "kysely";
import type { Database, Shift, Worker } from "../db/types.js";
import { writeAuditLog, type AuditEvent } from "./audit.js";

export type ContactChannel = "voice" | "sms" | "any";

export interface EligibilityResult {
  eligible: boolean;
  score: number;
  reasons: string[];
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function parseMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Empty availability means "not specified" and does not silently exclude a worker. */
export function availabilityCoversShift(worker: Pick<Worker, "availability" | "timezone">, shift: Pick<Shift, "startsAt" | "endsAt">): boolean | null {
  if (!worker.availability || Object.keys(worker.availability).length === 0) return null;
  const start = DateTime.fromJSDate(new Date(shift.startsAt), { zone: "utc" }).setZone(worker.timezone);
  const end = DateTime.fromJSDate(new Date(shift.endsAt), { zone: "utc" }).setZone(worker.timezone);
  if (!start.isValid || !end.isValid || end <= start) return false;

  let day = start.startOf("day");
  while (day < end) {
    const segmentStart = start > day ? start : day;
    const nextDay = day.plus({ days: 1 });
    const segmentEnd = end < nextDay ? end : nextDay;
    const key = day.toFormat("cccc").toLocaleLowerCase();
    const windows = worker.availability[key] ?? [];
    const segmentStartMinutes = segmentStart.hour * 60 + segmentStart.minute;
    const segmentEndMinutes = segmentEnd.equals(nextDay) ? 24 * 60 : segmentEnd.hour * 60 + segmentEnd.minute + (segmentEnd.second > 0 ? 1 : 0);
    const covered = windows.some((window) => {
      const windowStart = parseMinutes(window.start);
      let windowEnd = parseMinutes(window.end);
      if (windowStart === null || windowEnd === null) return false;
      if (window.end === "23:59") windowEnd = 24 * 60;
      return windowEnd > windowStart && segmentStartMinutes >= windowStart && segmentEndMinutes <= windowEnd;
    });
    if (!covered) return false;
    day = nextDay;
  }
  return true;
}

export function evaluateWorkerEligibility(
  worker: Worker,
  shift: Shift,
  options: { channel?: ContactChannel; hasConflict?: boolean; now?: Date } = {},
): EligibilityResult {
  const reasons: string[] = [];
  const channel = options.channel ?? "voice";
  const roles = new Set(worker.roles.map(normalize));
  const workerSkills = new Set(worker.skills.map(normalize));
  const now = options.now ?? new Date();
  for (const certification of worker.certifications) {
    const unexpired = !certification.expiresAt || new Date(`${certification.expiresAt}T23:59:59.999Z`) >= now;
    if (unexpired) workerSkills.add(normalize(certification.name));
  }
  const missingSkills = shift.requiredSkills.filter((skill) => !workerSkills.has(normalize(skill)));
  const availability = availabilityCoversShift(worker, shift);

  if (worker.status !== "active") reasons.push("worker_not_active");
  if (!roles.has(normalize(shift.role))) reasons.push("role_mismatch");
  if (missingSkills.length) reasons.push(`missing_skills:${missingSkills.join(",")}`);
  if (availability === false) reasons.push("outside_availability");
  if (options.hasConflict) reasons.push("schedule_conflict");
  if (channel === "voice" && (!worker.voiceConsent || worker.doNotCall)) reasons.push("not_voice_contactable");
  if (channel === "sms" && (!worker.smsConsent || worker.doNotText)) reasons.push("not_sms_contactable");
  if (channel === "any" && ((!worker.voiceConsent || worker.doNotCall) && (!worker.smsConsent || worker.doNotText))) reasons.push("not_contactable");

  if (reasons.length) return { eligible: false, score: 0, reasons };
  let score = 55;
  score += Math.min(20, shift.requiredSkills.length ? (shift.requiredSkills.length / Math.max(shift.requiredSkills.length, 1)) * 20 : 10);
  score += availability === true ? 15 : 5;
  if (!worker.lastContactedAt) score += 10;
  else {
    const hoursSinceContact = Math.max(0, (now.getTime() - new Date(worker.lastContactedAt).getTime()) / 3_600_000);
    score += Math.min(10, hoursSinceContact / 24);
  }
  return { eligible: true, score: Math.round(score * 10) / 10, reasons: availability === null ? ["availability_not_specified"] : [] };
}

export async function listEligibleWorkers(
  db: Kysely<Database> | Transaction<Database>,
  organizationId: string,
  shiftId: string,
  options: { channel?: ContactChannel; limit?: number } = {},
) {
  const shift = await db.selectFrom("shifts").selectAll()
    .where("id", "=", shiftId).where("organizationId", "=", organizationId).executeTakeFirst();
  if (!shift) return null;
  const workers = await db.selectFrom("workers").selectAll()
    .where("organizationId", "=", organizationId).where("status", "=", "active").execute();
  const conflicts = await db.selectFrom("assignments as a")
    .innerJoin("shifts as s", "s.id", "a.shiftId")
    .select("a.workerId")
    .where("a.organizationId", "=", organizationId)
    .where("a.status", "=", "accepted")
    .where("s.startsAt", "<", new Date(shift.endsAt))
    .where("s.endsAt", ">", new Date(shift.startsAt))
    .where("s.id", "!=", shift.id)
    .execute();
  const conflictedWorkers = new Set(conflicts.map((row) => row.workerId));
  const ranked = workers.map((worker) => ({
    worker,
    ...evaluateWorkerEligibility(worker, shift, {
      channel: options.channel,
      hasConflict: conflictedWorkers.has(worker.id),
    }),
  })).filter((candidate) => candidate.eligible)
    .sort((a, b) => b.score - a.score || String(a.worker.lastContactedAt ?? "").localeCompare(String(b.worker.lastContactedAt ?? "")))
    .slice(0, Math.min(Math.max(options.limit ?? 50, 1), 200));
  return { shift, workers: ranked };
}

export type SchedulingMutationResult =
  | { ok: true; assignmentId: string; status: "accepted" | "declined"; shiftStatus: Shift["status"] }
  | { ok: false; code: "not_found" | "invalid_state" | "shift_full" | "schedule_conflict"; message: string };

export async function acceptAssignment(
  db: Kysely<Database>,
  organizationId: string,
  assignmentId: string,
  audit?: Omit<AuditEvent, "organizationId" | "action" | "entityType" | "entityId">,
): Promise<SchedulingMutationResult> {
  return db.transaction().execute(async (trx) => {
    const assignment = await trx.selectFrom("assignments").selectAll()
      .where("id", "=", assignmentId).where("organizationId", "=", organizationId)
      .forUpdate().executeTakeFirst();
    if (!assignment) return { ok: false, code: "not_found", message: "Assignment not found" };

    // Consistent lock order for every acceptance: assignment, worker, then shift.
    // The worker lock serializes overlap checks across different shifts.
    const worker = await trx.selectFrom("workers").select(["id", "status"])
      .where("id", "=", assignment.workerId).where("organizationId", "=", organizationId)
      .forUpdate().executeTakeFirst();
    const shift = await trx.selectFrom("shifts").selectAll()
      .where("id", "=", assignment.shiftId).where("organizationId", "=", organizationId)
      .forUpdate().executeTakeFirst();
    if (!worker || !shift) return { ok: false, code: "not_found", message: "Worker or shift not found" };
    if (assignment.status === "accepted") return { ok: true, assignmentId, status: "accepted", shiftStatus: shift.status };
    if (worker.status !== "active" || !["candidate", "offered", "declined"].includes(assignment.status) || !["open", "filled"].includes(shift.status) || new Date(shift.startsAt) <= new Date()) {
      return { ok: false, code: "invalid_state", message: "This assignment can no longer be accepted" };
    }

    const acceptedCount = Number((await trx.selectFrom("assignments").select((eb) => eb.fn.countAll().as("count"))
      .where("organizationId", "=", organizationId).where("shiftId", "=", shift.id).where("status", "=", "accepted")
      .executeTakeFirstOrThrow()).count);
    if (acceptedCount >= shift.headcount) return { ok: false, code: "shift_full", message: "The shift is already fully staffed" };

    const conflict = await trx.selectFrom("assignments as a")
      .innerJoin("shifts as s", "s.id", "a.shiftId")
      .select("a.id")
      .where("a.organizationId", "=", organizationId)
      .where("a.workerId", "=", assignment.workerId)
      .where("a.status", "=", "accepted")
      .where("a.id", "!=", assignment.id)
      .where("s.startsAt", "<", new Date(shift.endsAt))
      .where("s.endsAt", ">", new Date(shift.startsAt))
      .executeTakeFirst();
    if (conflict) return { ok: false, code: "schedule_conflict", message: "The worker is already assigned to an overlapping shift" };

    const now = new Date();
    await trx.updateTable("assignments").set({
      status: "accepted", acceptedAt: now, declinedAt: null, declineReason: null,
    }).where("id", "=", assignment.id).where("organizationId", "=", organizationId).execute();
    const shiftStatus = acceptedCount + 1 >= shift.headcount ? "filled" : "open";
    if (shift.status !== shiftStatus) {
      await trx.updateTable("shifts").set({ status: shiftStatus }).where("id", "=", shift.id).where("organizationId", "=", organizationId).execute();
    }
    await writeAuditLog(trx, {
      organizationId,
      actorType: audit?.actorType ?? "system",
      actorId: audit?.actorId ?? null,
      actorLabel: audit?.actorLabel ?? "Scheduling system",
      ipAddress: audit?.ipAddress ?? null,
      metadata: { ...(audit?.metadata ?? {}), shiftId: shift.id, workerId: assignment.workerId },
      action: "assignment.accepted",
      entityType: "assignment",
      entityId: assignment.id,
    });
    return { ok: true, assignmentId, status: "accepted", shiftStatus };
  });
}

export async function declineAssignment(
  db: Kysely<Database>,
  organizationId: string,
  assignmentId: string,
  reason: string | null,
  audit?: Omit<AuditEvent, "organizationId" | "action" | "entityType" | "entityId">,
): Promise<SchedulingMutationResult> {
  return db.transaction().execute(async (trx) => {
    const assignment = await trx.selectFrom("assignments").selectAll()
      .where("id", "=", assignmentId).where("organizationId", "=", organizationId)
      .forUpdate().executeTakeFirst();
    if (!assignment) return { ok: false, code: "not_found", message: "Assignment not found" };
    const shift = await trx.selectFrom("shifts").selectAll()
      .where("id", "=", assignment.shiftId).where("organizationId", "=", organizationId)
      .forUpdate().executeTakeFirst();
    if (!shift) return { ok: false, code: "not_found", message: "Shift not found" };
    if (["cancelled", "completed", "no_show"].includes(assignment.status)) {
      return { ok: false, code: "invalid_state", message: "This assignment can no longer be declined" };
    }
    await trx.updateTable("assignments").set({
      status: "declined", declinedAt: new Date(), acceptedAt: null, declineReason: reason,
    }).where("id", "=", assignment.id).where("organizationId", "=", organizationId).execute();
    const shiftStatus = assignment.status === "accepted" && shift.status === "filled" ? "open" : shift.status;
    if (shiftStatus !== shift.status) {
      await trx.updateTable("shifts").set({ status: shiftStatus }).where("id", "=", shift.id).where("organizationId", "=", organizationId).execute();
    }
    await writeAuditLog(trx, {
      organizationId,
      actorType: audit?.actorType ?? "system",
      actorId: audit?.actorId ?? null,
      actorLabel: audit?.actorLabel ?? "Scheduling system",
      ipAddress: audit?.ipAddress ?? null,
      metadata: { ...(audit?.metadata ?? {}), shiftId: shift.id, workerId: assignment.workerId, reason },
      action: "assignment.declined",
      entityType: "assignment",
      entityId: assignment.id,
    });
    return { ok: true, assignmentId, status: "declined", shiftStatus };
  });
}

export async function enqueueShiftAutoFill(
  db: Kysely<Database>,
  organizationId: string,
  shiftId: string,
): Promise<{ jobId: string } | null> {
  return db.transaction().execute(async (trx) => {
    const shift = await trx.selectFrom("shifts").select(["id", "status"])
      .where("id", "=", shiftId).where("organizationId", "=", organizationId).forUpdate().executeTakeFirst();
    if (!shift || !["draft", "open"].includes(shift.status)) return null;
    const now = new Date();
    const jobId = nanoid();
    await trx.updateTable("shifts").set({
      autoFillEnabled: true,
      autoFillStartedAt: now,
      status: shift.status === "draft" ? "open" : shift.status,
    }).where("id", "=", shiftId).where("organizationId", "=", organizationId).execute();
    await trx.insertInto("jobs").values({
      id: jobId,
      organizationId,
      type: "campaign_tick",
      status: "pending",
      runAt: now,
      payload: { shiftId },
      idempotencyKey: `autofill:${shiftId}:${jobId}`,
      attempts: 0,
      maxAttempts: 5,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      completedAt: null,
    }).execute();
    return { jobId };
  });
}
