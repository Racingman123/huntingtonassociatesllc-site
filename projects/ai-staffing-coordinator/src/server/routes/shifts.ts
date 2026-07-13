import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { DateTime } from "luxon";
import { nanoid } from "nanoid";
import { z } from "zod";
import { isPgError, pageParams, requireManager } from "../plugins/http.js";
import { userAuditContext, writeAuditLog } from "../services/audit.js";
import { enqueueShiftAutoFill, listEligibleWorkers } from "../services/scheduling.js";

const nullableString = (max: number) => z.string().trim().max(max).nullable().optional();
const clientSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contactName: nullableString(200),
  contactEmail: z.string().trim().email().nullable().optional(),
  contactPhone: nullableString(30),
  active: z.boolean().default(true),
});
const locationSchema = z.object({
  clientId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().min(1).max(1000),
  timezone: z.string().trim().min(1).refine((zone) => DateTime.now().setZone(zone).isValid, "Invalid IANA timezone"),
  instructions: nullableString(5000),
});
const shiftSchema = z.object({
  clientId: z.string().trim().min(1),
  locationId: z.string().trim().min(1),
  role: z.string().trim().min(1).max(200),
  requiredSkills: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  headcount: z.coerce.number().int().min(1).max(10_000),
  payRateCents: z.coerce.number().int().min(0).nullable().optional(),
  status: z.enum(["draft", "open", "filled", "cancelled", "completed"]).default("draft"),
  notes: nullableString(5000),
  autoFillEnabled: z.boolean().default(false),
}).refine((value) => value.endsAt > value.startsAt, { path: ["endsAt"], message: "Shift must end after it starts" });

async function validateClientLocation(app: Parameters<FastifyPluginAsync>[0], organizationId: string, clientId: string, locationId: string) {
  return app.db.selectFrom("locations as l").innerJoin("clients as c", "c.id", "l.clientId")
    .select(["l.id", "l.clientId", "c.active"])
    .where("l.id", "=", locationId).where("l.clientId", "=", clientId)
    .where("l.organizationId", "=", organizationId).where("c.organizationId", "=", organizationId).executeTakeFirst();
}

function normalizeOptionalPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  return parsePhoneNumberFromString(value, "US")?.number ?? value;
}

export const clientRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/clients", async (request) => {
    const query = (request.query ?? {}) as { active?: string; limit?: string; offset?: string };
    const { limit, offset } = pageParams(query);
    let builder = app.db.selectFrom("clients").selectAll().where("organizationId", "=", request.user.organizationId);
    if (query.active === "true" || query.active === "false") builder = builder.where("active", "=", query.active === "true");
    const clients = await builder.orderBy("name").limit(limit).offset(offset).execute();
    return { clients, limit, offset };
  });

  app.get<{ Params: { id: string } }>("/clients/:id", async (request, reply) => {
    const client = await app.db.selectFrom("clients").selectAll().where("id", "=", request.params.id)
      .where("organizationId", "=", request.user.organizationId).executeTakeFirst();
    if (!client) return reply.code(404).send({ error: "not_found", message: "Client not found" });
    const locations = await app.db.selectFrom("locations").selectAll().where("clientId", "=", client.id)
      .where("organizationId", "=", request.user.organizationId).orderBy("name").execute();
    return { client, locations };
  });

  app.post("/clients", async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const parsed = clientSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation_error", message: "Client details are invalid", details: parsed.error.flatten() });
    try {
      const client = await app.db.insertInto("clients").values({
        ...parsed.data,
        id: nanoid(), organizationId: request.user.organizationId,
        contactName: parsed.data.contactName ?? null,
        contactEmail: parsed.data.contactEmail?.toLowerCase() ?? null,
        contactPhone: normalizeOptionalPhone(parsed.data.contactPhone),
      }).returningAll().executeTakeFirstOrThrow();
      await writeAuditLog(app.db, { ...userAuditContext(request), action: "client.created", entityType: "client", entityId: client.id });
      return reply.code(201).send({ client });
    } catch (error) {
      if (isPgError(error, "23505")) return reply.code(409).send({ error: "duplicate_client", message: "A client with this name already exists" });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/clients/:id", async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const parsed = clientSchema.partial().refine((v) => Object.keys(v).length > 0).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation_error", message: "Client details are invalid", details: parsed.error.flatten() });
    const update = { ...parsed.data };
    if (parsed.data.contactEmail !== undefined) update.contactEmail = parsed.data.contactEmail?.toLowerCase() ?? null;
    if (parsed.data.contactPhone !== undefined) update.contactPhone = normalizeOptionalPhone(parsed.data.contactPhone);
    try {
      const client = await app.db.updateTable("clients").set(update).where("id", "=", request.params.id)
        .where("organizationId", "=", request.user.organizationId).returningAll().executeTakeFirst();
      if (!client) return reply.code(404).send({ error: "not_found", message: "Client not found" });
      await writeAuditLog(app.db, { ...userAuditContext(request), action: "client.updated", entityType: "client", entityId: client.id, metadata: { fields: Object.keys(parsed.data) } });
      return { client };
    } catch (error) {
      if (isPgError(error, "23505")) return reply.code(409).send({ error: "duplicate_client", message: "A client with this name already exists" });
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>("/clients/:id", async (request, reply) => {
    if (!requireManager(request, reply)) return;
    try {
      const client = await app.db.deleteFrom("clients").where("id", "=", request.params.id).where("organizationId", "=", request.user.organizationId)
        .returning(["id", "name"]).executeTakeFirst();
      if (!client) return reply.code(404).send({ error: "not_found", message: "Client not found" });
      await writeAuditLog(app.db, { ...userAuditContext(request), action: "client.deleted", entityType: "client", entityId: client.id, metadata: { name: client.name } });
      return reply.code(204).send();
    } catch (error) {
      if (isPgError(error, "23503")) return reply.code(409).send({ error: "client_in_use", message: "Clients with locations or shifts cannot be deleted; mark the client inactive instead" });
      throw error;
    }
  });
};

export const locationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/locations", async (request) => {
    const query = (request.query ?? {}) as { clientId?: string; limit?: string; offset?: string };
    const { limit, offset } = pageParams(query);
    let builder = app.db.selectFrom("locations as l").innerJoin("clients as c", "c.id", "l.clientId")
      .selectAll("l").select("c.name as clientName").where("l.organizationId", "=", request.user.organizationId);
    if (query.clientId) builder = builder.where("l.clientId", "=", query.clientId);
    const locations = await builder.orderBy("c.name").orderBy("l.name").limit(limit).offset(offset).execute();
    return { locations, limit, offset };
  });

  app.get<{ Params: { id: string } }>("/locations/:id", async (request, reply) => {
    const location = await app.db.selectFrom("locations as l").innerJoin("clients as c", "c.id", "l.clientId")
      .selectAll("l").select("c.name as clientName").where("l.id", "=", request.params.id)
      .where("l.organizationId", "=", request.user.organizationId).executeTakeFirst();
    if (!location) return reply.code(404).send({ error: "not_found", message: "Location not found" });
    return { location };
  });

  app.post("/locations", async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const parsed = locationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation_error", message: "Location details are invalid", details: parsed.error.flatten() });
    const client = await app.db.selectFrom("clients").select("id").where("id", "=", parsed.data.clientId)
      .where("organizationId", "=", request.user.organizationId).executeTakeFirst();
    if (!client) return reply.code(400).send({ error: "invalid_client", message: "Client not found in this organization" });
    try {
      const location = await app.db.insertInto("locations").values({
        ...parsed.data, id: nanoid(), organizationId: request.user.organizationId, instructions: parsed.data.instructions ?? null,
      }).returningAll().executeTakeFirstOrThrow();
      await writeAuditLog(app.db, { ...userAuditContext(request), action: "location.created", entityType: "location", entityId: location.id });
      return reply.code(201).send({ location });
    } catch (error) {
      if (isPgError(error, "23505")) return reply.code(409).send({ error: "duplicate_location", message: "This client already has a location with that name" });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/locations/:id", async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const parsed = locationSchema.partial().refine((v) => Object.keys(v).length > 0).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation_error", message: "Location details are invalid", details: parsed.error.flatten() });
    if (parsed.data.clientId) {
      const client = await app.db.selectFrom("clients").select("id").where("id", "=", parsed.data.clientId)
        .where("organizationId", "=", request.user.organizationId).executeTakeFirst();
      if (!client) return reply.code(400).send({ error: "invalid_client", message: "Client not found in this organization" });
    }
    try {
      const location = await app.db.updateTable("locations").set(parsed.data).where("id", "=", request.params.id)
        .where("organizationId", "=", request.user.organizationId).returningAll().executeTakeFirst();
      if (!location) return reply.code(404).send({ error: "not_found", message: "Location not found" });
      await writeAuditLog(app.db, { ...userAuditContext(request), action: "location.updated", entityType: "location", entityId: location.id, metadata: { fields: Object.keys(parsed.data) } });
      return { location };
    } catch (error) {
      if (isPgError(error, "23505")) return reply.code(409).send({ error: "duplicate_location", message: "This client already has a location with that name" });
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>("/locations/:id", async (request, reply) => {
    if (!requireManager(request, reply)) return;
    try {
      const location = await app.db.deleteFrom("locations").where("id", "=", request.params.id)
        .where("organizationId", "=", request.user.organizationId).returning(["id", "name"]).executeTakeFirst();
      if (!location) return reply.code(404).send({ error: "not_found", message: "Location not found" });
      await writeAuditLog(app.db, { ...userAuditContext(request), action: "location.deleted", entityType: "location", entityId: location.id, metadata: { name: location.name } });
      return reply.code(204).send();
    } catch (error) {
      if (isPgError(error, "23503")) return reply.code(409).send({ error: "location_in_use", message: "Locations used by shifts cannot be deleted" });
      throw error;
    }
  });
};

export const shiftRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/shifts", async (request) => {
    const query = (request.query ?? {}) as { status?: string; from?: string; to?: string; limit?: string; offset?: string };
    const { limit, offset } = pageParams(query);
    let builder = app.db.selectFrom("shifts as s")
      .innerJoin("clients as c", "c.id", "s.clientId").innerJoin("locations as l", "l.id", "s.locationId")
      .selectAll("s").select(["c.name as clientName", "l.name as locationName", "l.address", "l.timezone"])
      .select((eb) => eb.selectFrom("assignments as a").select((countEb) => countEb.fn.countAll<number>().as("count"))
        .whereRef("a.shiftId", "=", "s.id").where("a.organizationId", "=", request.user.organizationId)
        .where("a.status", "=", "accepted").as("acceptedCount"))
      .where("s.organizationId", "=", request.user.organizationId);
    if (["draft", "open", "filled", "cancelled", "completed"].includes(query.status ?? "")) builder = builder.where("s.status", "=", query.status as never);
    if (query.from && !Number.isNaN(Date.parse(query.from))) builder = builder.where("s.startsAt", ">=", new Date(query.from));
    if (query.to && !Number.isNaN(Date.parse(query.to))) builder = builder.where("s.startsAt", "<", new Date(query.to));
    const rows = await builder.orderBy("s.startsAt").limit(limit).offset(offset).execute();
    return { shifts: rows.map((row) => ({ ...row, acceptedCount: Number(row.acceptedCount) })), limit, offset };
  });

  app.get<{ Params: { id: string } }>("/shifts/:id", async (request, reply) => {
    const shift = await app.db.selectFrom("shifts as s").innerJoin("clients as c", "c.id", "s.clientId")
      .innerJoin("locations as l", "l.id", "s.locationId").selectAll("s")
      .select(["c.name as clientName", "l.name as locationName", "l.address", "l.timezone", "l.instructions"])
      .where("s.id", "=", request.params.id).where("s.organizationId", "=", request.user.organizationId).executeTakeFirst();
    if (!shift) return reply.code(404).send({ error: "not_found", message: "Shift not found" });
    const assignments = await app.db.selectFrom("assignments as a").innerJoin("workers as w", "w.id", "a.workerId")
      .selectAll("a").select(["w.firstName", "w.lastName", "w.phone"]).where("a.shiftId", "=", shift.id)
      .where("a.organizationId", "=", request.user.organizationId).orderBy("a.createdAt").execute();
    return { shift, assignments };
  });

  app.post("/shifts", async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const parsed = shiftSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation_error", message: "Shift details are invalid", details: parsed.error.flatten() });
    if (!["draft", "open"].includes(parsed.data.status)) {
      return reply.code(400).send({ error: "invalid_status", message: "New shifts must be draft or open" });
    }
    const valid = await validateClientLocation(app, request.user.organizationId, parsed.data.clientId, parsed.data.locationId);
    if (!valid) return reply.code(400).send({ error: "invalid_location", message: "Client and location do not match this organization" });
    const shift = await app.db.insertInto("shifts").values({
      ...parsed.data,
      id: nanoid(), organizationId: request.user.organizationId,
      payRateCents: parsed.data.payRateCents ?? null, notes: parsed.data.notes ?? null, autoFillStartedAt: null,
    }).returningAll().executeTakeFirstOrThrow();
    await writeAuditLog(app.db, { ...userAuditContext(request), action: "shift.created", entityType: "shift", entityId: shift.id });
    let autoFillJob: { jobId: string } | null = null;
    if (shift.autoFillEnabled && shift.status === "open") autoFillJob = await enqueueShiftAutoFill(app.db, request.user.organizationId, shift.id);
    return reply.code(201).send({ shift, autoFillJob });
  });

  app.patch<{ Params: { id: string } }>("/shifts/:id", async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const current = await app.db.selectFrom("shifts").selectAll().where("id", "=", request.params.id)
      .where("organizationId", "=", request.user.organizationId).executeTakeFirst();
    if (!current) return reply.code(404).send({ error: "not_found", message: "Shift not found" });
    const parsed = shiftSchema.partial().refine((v) => Object.keys(v).length > 0).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation_error", message: "Shift details are invalid", details: parsed.error.flatten() });
    const startsAt = parsed.data.startsAt ?? new Date(current.startsAt);
    const endsAt = parsed.data.endsAt ?? new Date(current.endsAt);
    if (endsAt <= startsAt) return reply.code(400).send({ error: "validation_error", message: "Shift must end after it starts" });
    const clientId = parsed.data.clientId ?? current.clientId;
    const locationId = parsed.data.locationId ?? current.locationId;
    if (!(await validateClientLocation(app, request.user.organizationId, clientId, locationId))) {
      return reply.code(400).send({ error: "invalid_location", message: "Client and location do not match this organization" });
    }
    const accepted = Number((await app.db.selectFrom("assignments").select((eb) => eb.fn.countAll().as("count"))
      .where("organizationId", "=", request.user.organizationId).where("shiftId", "=", current.id).where("status", "=", "accepted").executeTakeFirstOrThrow()).count);
    if (parsed.data.headcount !== undefined && parsed.data.headcount < accepted) {
      return reply.code(409).send({ error: "headcount_below_accepted", message: "Headcount cannot be lower than accepted assignments" });
    }
    const scheduleFields = ["clientId", "locationId", "role", "requiredSkills", "startsAt", "endsAt"] as const;
    if (accepted > 0 && scheduleFields.some((field) => parsed.data[field] !== undefined)) {
      return reply.code(409).send({ error: "accepted_assignments_exist", message: "Scheduling and qualification fields cannot change while workers are accepted; cancel the assignments first" });
    }
    if (["cancelled", "completed"].includes(current.status) && parsed.data.status && parsed.data.status !== current.status) {
      return reply.code(409).send({ error: "terminal_shift", message: "Cancelled or completed shifts cannot be reopened" });
    }
    if (parsed.data.status === "filled") {
      return reply.code(409).send({ error: "computed_status", message: "Filled status is set automatically when headcount is reached" });
    }
    if (parsed.data.status === "open" && accepted >= (parsed.data.headcount ?? current.headcount)) {
      return reply.code(409).send({ error: "shift_full", message: "A shift at accepted headcount cannot be marked open" });
    }
    const updateData = { ...parsed.data };
    if (parsed.data.headcount !== undefined && parsed.data.status === undefined && ["open", "filled"].includes(current.status)) {
      updateData.status = accepted >= parsed.data.headcount ? "filled" : "open";
    }
    const shift = await app.db.transaction().execute(async (trx) => {
      const updated = await trx.updateTable("shifts").set(updateData).where("id", "=", current.id)
        .where("organizationId", "=", request.user.organizationId).returningAll().executeTakeFirstOrThrow();
      if (parsed.data.status === "cancelled") {
        await trx.updateTable("assignments").set({ status: "cancelled", acceptedAt: null })
          .where("organizationId", "=", request.user.organizationId).where("shiftId", "=", current.id)
          .where("status", "in", ["candidate", "offered", "accepted"]).execute();
      } else if (parsed.data.status === "completed") {
        await trx.updateTable("assignments").set({ status: "completed" })
          .where("organizationId", "=", request.user.organizationId).where("shiftId", "=", current.id)
          .where("status", "=", "accepted").execute();
      }
      await writeAuditLog(trx, { ...userAuditContext(request), action: "shift.updated", entityType: "shift", entityId: updated.id, metadata: { fields: Object.keys(parsed.data) } });
      return updated;
    });
    return { shift };
  });

  app.delete<{ Params: { id: string } }>("/shifts/:id", async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const shift = await app.db.selectFrom("shifts").select(["id", "status"]).where("id", "=", request.params.id)
      .where("organizationId", "=", request.user.organizationId).executeTakeFirst();
    if (!shift) return reply.code(404).send({ error: "not_found", message: "Shift not found" });
    if (shift.status !== "draft") return reply.code(409).send({ error: "shift_in_use", message: "Only draft shifts can be deleted; cancel this shift instead" });
    await app.db.deleteFrom("shifts").where("id", "=", shift.id).where("organizationId", "=", request.user.organizationId).execute();
    await writeAuditLog(app.db, { ...userAuditContext(request), action: "shift.deleted", entityType: "shift", entityId: shift.id });
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/shifts/:id/eligible-workers", async (request, reply) => {
    const query = (request.query ?? {}) as { channel?: "voice" | "sms" | "any"; limit?: string };
    const result = await listEligibleWorkers(app.db, request.user.organizationId, request.params.id, {
      channel: ["voice", "sms", "any"].includes(query.channel ?? "") ? query.channel : "voice",
      limit: Number(query.limit) || 50,
    });
    if (!result) return reply.code(404).send({ error: "not_found", message: "Shift not found" });
    return { workers: result.workers.map(({ worker, score, reasons }) => ({ ...worker, score, reasons })) };
  });

  app.post<{ Params: { id: string } }>("/shifts/:id/auto-fill", async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const job = await enqueueShiftAutoFill(app.db, request.user.organizationId, request.params.id);
    if (!job) return reply.code(409).send({ error: "invalid_shift", message: "Shift cannot be auto-filled" });
    await writeAuditLog(app.db, { ...userAuditContext(request), action: "shift.autofill_started", entityType: "shift", entityId: request.params.id, metadata: job });
    return reply.code(202).send(job);
  });
};
