import type { FastifyPluginAsync } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { isPgError, pageParams, requireManager } from "../plugins/http.js";
import { userAuditContext, writeAuditLog } from "../services/audit.js";
import { acceptAssignment, declineAssignment } from "../services/scheduling.js";

const statusSchema = z.enum(["candidate", "offered", "accepted", "declined", "cancelled", "completed", "no_show"]);
const createSchema = z.object({
  shiftId: z.string().trim().min(1),
  workerId: z.string().trim().min(1),
  status: statusSchema.default("candidate"),
  source: z.enum(["manual", "voice", "sms", "automation"]).default("manual"),
  declineReason: z.string().trim().max(1000).nullable().optional(),
});
const updateSchema = z.object({
  status: statusSchema,
  declineReason: z.string().trim().max(1000).nullable().optional(),
});
const declineSchema = z.object({ reason: z.string().trim().max(1000).nullable().optional() });

function statusCodeFor(result: Awaited<ReturnType<typeof acceptAssignment>>): number {
  if (result.ok) return 200;
  if (result.code === "not_found") return 404;
  if (result.code === "shift_full" || result.code === "schedule_conflict" || result.code === "invalid_state") return 409;
  return 400;
}

export const assignmentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/assignments", async (request) => {
    const query = (request.query ?? {}) as { status?: string; shiftId?: string; workerId?: string; upcoming?: string; limit?: string; offset?: string };
    const { limit, offset } = pageParams(query);
    let builder = app.db.selectFrom("assignments as a").innerJoin("workers as w", "w.id", "a.workerId")
      .innerJoin("shifts as s", "s.id", "a.shiftId").innerJoin("clients as c", "c.id", "s.clientId")
      .innerJoin("locations as l", "l.id", "s.locationId").selectAll("a")
      .select(["w.firstName", "w.lastName", "w.phone", "s.role as shiftRole", "s.startsAt as shiftStartsAt", "s.endsAt as shiftEndsAt", "c.name as clientName", "l.name as locationName"])
      .where("a.organizationId", "=", request.user.organizationId);
    if (statusSchema.options.includes(query.status as never)) builder = builder.where("a.status", "=", query.status as never);
    if (query.shiftId) builder = builder.where("a.shiftId", "=", query.shiftId);
    if (query.workerId) builder = builder.where("a.workerId", "=", query.workerId);
    if (query.upcoming === "true") builder = builder.where("s.startsAt", ">=", new Date());
    const assignments = await builder.orderBy("s.startsAt").limit(limit).offset(offset).execute();
    return { assignments, limit, offset };
  });

  app.get<{ Params: { id: string } }>("/assignments/:id", async (request, reply) => {
    const assignment = await app.db.selectFrom("assignments as a").innerJoin("workers as w", "w.id", "a.workerId")
      .innerJoin("shifts as s", "s.id", "a.shiftId").innerJoin("clients as c", "c.id", "s.clientId")
      .innerJoin("locations as l", "l.id", "s.locationId").selectAll("a")
      .select(["w.firstName", "w.lastName", "w.phone", "s.role as shiftRole", "s.startsAt", "s.endsAt", "s.notes as shiftNotes", "c.name as clientName", "l.name as locationName", "l.address", "l.timezone", "l.instructions"])
      .where("a.id", "=", request.params.id).where("a.organizationId", "=", request.user.organizationId).executeTakeFirst();
    if (!assignment) return reply.code(404).send({ error: "not_found", message: "Assignment not found" });
    return { assignment };
  });

  app.post("/assignments", async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation_error", message: "Assignment details are invalid", details: parsed.error.flatten() });
    const [worker, shift] = await Promise.all([
      app.db.selectFrom("workers").select(["id", "status"]).where("id", "=", parsed.data.workerId).where("organizationId", "=", request.user.organizationId).executeTakeFirst(),
      app.db.selectFrom("shifts").select(["id", "status"]).where("id", "=", parsed.data.shiftId).where("organizationId", "=", request.user.organizationId).executeTakeFirst(),
    ]);
    if (!worker) return reply.code(400).send({ error: "invalid_worker", message: "Worker not found in this organization" });
    if (!shift) return reply.code(400).send({ error: "invalid_shift", message: "Shift not found in this organization" });
    if (worker.status !== "active") return reply.code(409).send({ error: "worker_inactive", message: "Inactive or suspended workers cannot be assigned" });
    if (["cancelled", "completed"].includes(shift.status)) return reply.code(409).send({ error: "shift_closed", message: "This shift is not accepting assignments" });
    const requestedStatus = parsed.data.status;
    const initialStatus = requestedStatus === "accepted" ? "candidate" : requestedStatus;
    try {
      const assignment = await app.db.insertInto("assignments").values({
        id: nanoid(), organizationId: request.user.organizationId,
        shiftId: parsed.data.shiftId, workerId: parsed.data.workerId,
        status: initialStatus, source: parsed.data.source,
        offeredAt: initialStatus === "offered" ? new Date() : null,
        acceptedAt: null,
        declinedAt: initialStatus === "declined" ? new Date() : null,
        declineReason: initialStatus === "declined" ? parsed.data.declineReason ?? null : null,
      }).returningAll().executeTakeFirstOrThrow();
      await writeAuditLog(app.db, { ...userAuditContext(request), action: "assignment.created", entityType: "assignment", entityId: assignment.id, metadata: { workerId: assignment.workerId, shiftId: assignment.shiftId } });
      if (requestedStatus === "accepted") {
        const result = await acceptAssignment(app.db, request.user.organizationId, assignment.id, userAuditContext(request));
        if (!result.ok) return reply.code(statusCodeFor(result)).send({ error: result.code, message: result.message, assignment });
        const accepted = await app.db.selectFrom("assignments").selectAll().where("id", "=", assignment.id).executeTakeFirstOrThrow();
        return reply.code(201).send({ assignment: accepted });
      }
      return reply.code(201).send({ assignment });
    } catch (error) {
      if (isPgError(error, "23505")) return reply.code(409).send({ error: "duplicate_assignment", message: "This worker is already linked to this shift" });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/assignments/:id", async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation_error", message: "Assignment update is invalid", details: parsed.error.flatten() });
    if (parsed.data.status === "accepted") {
      const result = await acceptAssignment(app.db, request.user.organizationId, request.params.id, userAuditContext(request));
      return reply.code(statusCodeFor(result)).send(result.ok ? result : { error: result.code, message: result.message });
    }
    if (parsed.data.status === "declined") {
      const result = await declineAssignment(app.db, request.user.organizationId, request.params.id, parsed.data.declineReason ?? null, userAuditContext(request));
      return reply.code(statusCodeFor(result)).send(result.ok ? result : { error: result.code, message: result.message });
    }
    const result = await app.db.transaction().execute(async (trx) => {
      const assignment = await trx.selectFrom("assignments").selectAll().where("id", "=", request.params.id)
        .where("organizationId", "=", request.user.organizationId).forUpdate().executeTakeFirst();
      if (!assignment) return null;
      const shift = await trx.selectFrom("shifts").select(["id", "status"]).where("id", "=", assignment.shiftId)
        .where("organizationId", "=", request.user.organizationId).forUpdate().executeTakeFirst();
      const now = new Date();
      const assignmentUpdate = {
        status: parsed.data.status,
        offeredAt: parsed.data.status === "offered" ? now : assignment.offeredAt,
        acceptedAt: parsed.data.status === "candidate" || parsed.data.status === "offered" || parsed.data.status === "cancelled" ? null : assignment.acceptedAt,
        declinedAt: null,
        declineReason: null,
      };
      const updated = await trx.updateTable("assignments").set(assignmentUpdate).where("id", "=", assignment.id).returningAll().executeTakeFirstOrThrow();
      if (assignment.status === "accepted" && shift?.status === "filled") {
        await trx.updateTable("shifts").set({ status: "open" }).where("id", "=", shift.id).execute();
      }
      await writeAuditLog(trx, { ...userAuditContext(request), action: "assignment.updated", entityType: "assignment", entityId: assignment.id, metadata: { from: assignment.status, to: parsed.data.status } });
      return updated;
    });
    if (!result) return reply.code(404).send({ error: "not_found", message: "Assignment not found" });
    return { assignment: result };
  });

  app.post<{ Params: { id: string } }>("/assignments/:id/accept", async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const result = await acceptAssignment(app.db, request.user.organizationId, request.params.id, userAuditContext(request));
    return reply.code(statusCodeFor(result)).send(result.ok ? result : { error: result.code, message: result.message });
  });

  app.post<{ Params: { id: string } }>("/assignments/:id/decline", async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const parsed = declineSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "validation_error", message: "Decline details are invalid", details: parsed.error.flatten() });
    const result = await declineAssignment(app.db, request.user.organizationId, request.params.id, parsed.data.reason ?? null, userAuditContext(request));
    return reply.code(statusCodeFor(result)).send(result.ok ? result : { error: result.code, message: result.message });
  });

  app.delete<{ Params: { id: string } }>("/assignments/:id", async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const assignment = await app.db.selectFrom("assignments").select(["id", "status"]).where("id", "=", request.params.id)
      .where("organizationId", "=", request.user.organizationId).executeTakeFirst();
    if (!assignment) return reply.code(404).send({ error: "not_found", message: "Assignment not found" });
    if (!['candidate'].includes(assignment.status)) return reply.code(409).send({ error: "assignment_in_use", message: "Only candidate assignments can be deleted; cancel other assignments instead" });
    await app.db.deleteFrom("assignments").where("id", "=", assignment.id).where("organizationId", "=", request.user.organizationId).execute();
    await writeAuditLog(app.db, { ...userAuditContext(request), action: "assignment.deleted", entityType: "assignment", entityId: assignment.id });
    return reply.code(204).send();
  });
};
