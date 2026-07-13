import type { FastifyPluginAsync } from "fastify";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { DateTime } from "luxon";
import { nanoid } from "nanoid";
import { z } from "zod";
import { isPgError, pageParams, requireManager } from "../plugins/http.js";
import { userAuditContext, writeAuditLog } from "../services/audit.js";

const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const availabilityWindow = z.object({ start: z.string().regex(timePattern), end: z.string().regex(timePattern) })
  .refine((window) => window.end > window.start, { message: "Availability end must be after start" });
const workerSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(7).max(30),
  email: z.string().trim().email().nullable().optional(),
  status: z.enum(["active", "inactive", "suspended"]).default("active"),
  roles: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  skills: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  certifications: z.array(z.object({ name: z.string().trim().min(1), expiresAt: z.iso.date().optional() })).max(100).default([]),
  availability: z.record(z.string(), z.array(availabilityWindow)).default({}),
  timezone: z.string().trim().min(1).refine((zone) => DateTime.now().setZone(zone).isValid, "Invalid IANA timezone").default("America/New_York"),
  address: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  voiceConsent: z.boolean().default(false),
  voiceConsentSource: z.string().trim().max(100).nullable().optional(),
  smsConsent: z.boolean().default(false),
  smsConsentSource: z.string().trim().max(100).nullable().optional(),
  doNotCall: z.boolean().default(false),
  doNotText: z.boolean().default(false),
});
const workerUpdateSchema = workerSchema.partial().refine((value) => Object.keys(value).length > 0, "At least one field is required");

function normalizePhone(input: string): string | null {
  const parsed = parsePhoneNumberFromString(input, "US");
  return parsed?.isValid() ? parsed.number : null;
}

export const workerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/workers", async (request) => {
    const query = (request.query ?? {}) as { search?: string; status?: string; limit?: string; offset?: string };
    const { limit, offset } = pageParams(query);
    let dbQuery = app.db.selectFrom("workers").selectAll().where("organizationId", "=", request.user.organizationId);
    if (["active", "inactive", "suspended"].includes(query.status ?? "")) {
      dbQuery = dbQuery.where("status", "=", query.status as "active" | "inactive" | "suspended");
    }
    if (query.search?.trim()) {
      const search = `%${query.search.trim()}%`;
      dbQuery = dbQuery.where((eb) => eb.or([
        eb("firstName", "ilike", search), eb("lastName", "ilike", search), eb("phone", "ilike", search), eb("email", "ilike", search),
      ]));
    }
    const workers = await dbQuery.orderBy("lastName").orderBy("firstName").limit(limit).offset(offset).execute();
    return { workers, limit, offset };
  });

  app.get<{ Params: { id: string } }>("/workers/:id", async (request, reply) => {
    const worker = await app.db.selectFrom("workers").selectAll()
      .where("id", "=", request.params.id).where("organizationId", "=", request.user.organizationId).executeTakeFirst();
    if (!worker) return reply.code(404).send({ error: "not_found", message: "Worker not found" });
    const assignments = await app.db.selectFrom("assignments as a")
      .innerJoin("shifts as s", "s.id", "a.shiftId")
      .innerJoin("clients as c", "c.id", "s.clientId")
      .select(["a.id", "a.status", "a.shiftId", "s.role", "s.startsAt", "s.endsAt", "c.name as clientName"])
      .where("a.organizationId", "=", request.user.organizationId).where("a.workerId", "=", worker.id)
      .orderBy("s.startsAt", "desc").limit(50).execute();
    return { worker, assignments };
  });

  app.post("/workers", async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const parsed = workerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation_error", message: "Worker details are invalid", details: parsed.error.flatten() });
    if (parsed.data.voiceConsent && !parsed.data.voiceConsentSource) {
      return reply.code(400).send({ error: "validation_error", message: "Voice consent requires a recorded consent source" });
    }
    if (parsed.data.smsConsent && !parsed.data.smsConsentSource) {
      return reply.code(400).send({ error: "validation_error", message: "SMS consent requires a recorded consent source" });
    }
    const phone = normalizePhone(parsed.data.phone);
    if (!phone) return reply.code(400).send({ error: "validation_error", message: "A valid worker phone number is required" });
    const now = new Date();
    const worker = {
      ...parsed.data,
      id: nanoid(),
      organizationId: request.user.organizationId,
      phone,
      email: parsed.data.email?.toLowerCase() ?? null,
      address: parsed.data.address ?? null,
      notes: parsed.data.notes ?? null,
      voiceConsentAt: parsed.data.voiceConsent ? now : null,
      voiceConsentSource: parsed.data.voiceConsentSource ?? null,
      smsConsentAt: parsed.data.smsConsent ? now : null,
      smsConsentSource: parsed.data.smsConsentSource ?? null,
      lastContactedAt: null,
    };
    try {
      const created = await app.db.insertInto("workers").values(worker).returningAll().executeTakeFirstOrThrow();
      await writeAuditLog(app.db, { ...userAuditContext(request), action: "worker.created", entityType: "worker", entityId: created.id });
      return reply.code(201).send({ worker: created });
    } catch (error) {
      if (isPgError(error, "23505")) return reply.code(409).send({ error: "duplicate_worker", message: "A worker with that phone or email already exists" });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/workers/:id", async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const parsed = workerUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation_error", message: "Worker details are invalid", details: parsed.error.flatten() });
    const current = await app.db.selectFrom("workers").selectAll().where("id", "=", request.params.id)
      .where("organizationId", "=", request.user.organizationId).executeTakeFirst();
    if (!current) return reply.code(404).send({ error: "not_found", message: "Worker not found" });
    if (parsed.data.voiceConsent === true && !(parsed.data.voiceConsentSource ?? current.voiceConsentSource)) {
      return reply.code(400).send({ error: "validation_error", message: "Voice consent requires a recorded consent source" });
    }
    if (parsed.data.smsConsent === true && !(parsed.data.smsConsentSource ?? current.smsConsentSource)) {
      return reply.code(400).send({ error: "validation_error", message: "SMS consent requires a recorded consent source" });
    }
    const update: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.phone !== undefined) {
      const phone = normalizePhone(parsed.data.phone);
      if (!phone) return reply.code(400).send({ error: "validation_error", message: "A valid worker phone number is required" });
      update.phone = phone;
    }
    if (parsed.data.email !== undefined) update.email = parsed.data.email?.toLowerCase() ?? null;
    if (parsed.data.voiceConsent !== undefined && parsed.data.voiceConsent !== current.voiceConsent) {
      update.voiceConsentAt = parsed.data.voiceConsent ? new Date() : null;
      if (!parsed.data.voiceConsent) update.voiceConsentSource = null;
    }
    if (parsed.data.smsConsent !== undefined && parsed.data.smsConsent !== current.smsConsent) {
      update.smsConsentAt = parsed.data.smsConsent ? new Date() : null;
      if (!parsed.data.smsConsent) update.smsConsentSource = null;
    }
    try {
      const worker = await app.db.updateTable("workers").set(update).where("id", "=", current.id)
        .where("organizationId", "=", request.user.organizationId).returningAll().executeTakeFirstOrThrow();
      await writeAuditLog(app.db, { ...userAuditContext(request), action: "worker.updated", entityType: "worker", entityId: worker.id, metadata: { fields: Object.keys(parsed.data) } });
      return { worker };
    } catch (error) {
      if (isPgError(error, "23505")) return reply.code(409).send({ error: "duplicate_worker", message: "A worker with that phone or email already exists" });
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>("/workers/:id", async (request, reply) => {
    if (!requireManager(request, reply)) return;
    try {
      const worker = await app.db.deleteFrom("workers").where("id", "=", request.params.id)
        .where("organizationId", "=", request.user.organizationId).returning(["id", "firstName", "lastName"]).executeTakeFirst();
      if (!worker) return reply.code(404).send({ error: "not_found", message: "Worker not found" });
      await writeAuditLog(app.db, { ...userAuditContext(request), action: "worker.deleted", entityType: "worker", entityId: worker.id, metadata: { name: `${worker.firstName} ${worker.lastName}` } });
      return reply.code(204).send();
    } catch (error) {
      if (isPgError(error, "23503")) return reply.code(409).send({ error: "worker_in_use", message: "Workers with scheduling history cannot be deleted; mark the worker inactive instead" });
      throw error;
    }
  });
};
