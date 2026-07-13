import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getCommunicationsProvider } from "../services/communications.js";
import { queueOutboundCall } from "../services/reminder-worker.js";

const createCallBody = z
  .object({
    workerId: z.string().min(1),
    shiftId: z.string().min(1),
    assignmentId: z.string().min(1).optional(),
  })
  .strict();

const idParams = z.object({ id: z.string().min(1) });

function ensureScheduler(role: "admin" | "scheduler" | "viewer"): void {
  if (role === "viewer") throw Object.assign(new Error("Scheduler or administrator access is required"), { statusCode: 403 });
}

export const callRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/messages", { preHandler: app.authenticate }, async (request) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query ?? {});
    const rows = await app.db
      .selectFrom("messages as message")
      .innerJoin("workers as worker", (join) =>
        join.onRef("worker.id", "=", "message.workerId").onRef("worker.organizationId", "=", "message.organizationId"),
      )
      .select([
        "message.id",
        "message.workerId",
        "message.assignmentId",
        "message.providerMessageId",
        "message.direction",
        "message.channel",
        "message.body",
        "message.status",
        "message.errorMessage",
        "message.sentAt",
        "message.deliveredAt",
        "message.createdAt",
        "worker.firstName",
        "worker.lastName",
      ])
      .where("message.organizationId", "=", request.user.organizationId)
      .orderBy("message.createdAt", "desc")
      .limit(query.limit)
      .execute();
    return {
      messages: rows.map(({ firstName, lastName, ...message }) => ({
        ...message,
        workerName: `${firstName} ${lastName}`,
      })),
    };
  });

  app.get("/api/calls", { preHandler: app.authenticate }, async (request) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query ?? {});
    const rows = await app.db
      .selectFrom("callSessions as call")
      .innerJoin("workers as worker", (join) =>
        join.onRef("worker.id", "=", "call.workerId").onRef("worker.organizationId", "=", "call.organizationId"),
      )
      .leftJoin("shifts as shift", (join) =>
        join.onRef("shift.id", "=", "call.shiftId").onRef("shift.organizationId", "=", "call.organizationId"),
      )
      .select([
        "call.id",
        "call.workerId",
        "call.shiftId",
        "call.assignmentId",
        "call.providerCallId",
        "call.status",
        "call.direction",
        "call.attempt",
        "call.startedAt",
        "call.endedAt",
        "call.outcome",
        "call.errorMessage",
        "call.createdAt",
        "worker.firstName",
        "worker.lastName",
        "shift.role as shiftRole",
        "shift.startsAt as shiftStartsAt",
      ])
      .where("call.organizationId", "=", request.user.organizationId)
      .orderBy("call.createdAt", "desc")
      .limit(query.limit)
      .execute();
    return {
      calls: rows.map(({ firstName, lastName, shiftRole, shiftStartsAt, ...call }) => ({
        ...call,
        workerName: `${firstName} ${lastName}`,
        shiftLabel: shiftRole ? `${shiftRole}${shiftStartsAt ? ` · ${new Date(shiftStartsAt).toLocaleString()}` : ""}` : null,
        durationSeconds:
          call.startedAt && call.endedAt
            ? Math.max(0, Math.round((new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 1_000))
            : null,
      })),
    };
  });

  app.get("/api/calls/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const row = await app.db
      .selectFrom("callSessions as call")
      .innerJoin("workers as worker", (join) =>
        join.onRef("worker.id", "=", "call.workerId").onRef("worker.organizationId", "=", "call.organizationId"),
      )
      .leftJoin("shifts as shift", (join) =>
        join.onRef("shift.id", "=", "call.shiftId").onRef("shift.organizationId", "=", "call.organizationId"),
      )
      .selectAll("call")
      .select(["worker.firstName", "worker.lastName", "shift.role as shiftRole", "shift.startsAt as shiftStartsAt"])
      .where("call.id", "=", id)
      .where("call.organizationId", "=", request.user.organizationId)
      .executeTakeFirst();
    if (!row) return reply.code(404).send({ error: "not_found", message: "Call session not found" });
    const turns = await app.db
      .selectFrom("conversationTurns")
      .select(["id", "sequence", "speaker", "text", "toolName", "createdAt"])
      .where("callSessionId", "=", id)
      .where("organizationId", "=", request.user.organizationId)
      .orderBy("sequence", "asc")
      .execute();
    const { firstName, lastName, shiftRole, shiftStartsAt, ...call } = row;
    return {
      call: {
        ...call,
        workerName: `${firstName} ${lastName}`,
        shiftLabel: shiftRole ? `${shiftRole}${shiftStartsAt ? ` · ${new Date(shiftStartsAt).toLocaleString()}` : ""}` : null,
        durationSeconds:
          call.startedAt && call.endedAt
            ? Math.max(0, Math.round((new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 1_000))
            : null,
        transcript: turns,
      },
    };
  });

  app.post("/api/calls", { preHandler: app.authenticate }, async (request, reply) => {
    ensureScheduler(request.user.role);
    const body = createCallBody.parse(request.body);
    try {
      const queued = await queueOutboundCall(app, {
        organizationId: request.user.organizationId,
        workerId: body.workerId,
        shiftId: body.shiftId,
        assignmentId: body.assignmentId,
      });
      return reply.code(202).send({
        callSessionId: queued.callSessionId,
        jobId: queued.jobId,
        status: "queued",
        queuedFor: queued.queuedFor.toISOString(),
        reused: queued.reused,
      });
    } catch (error) {
      return reply.code(409).send({
        error: "call_not_queued",
        message: error instanceof Error ? error.message : "The call could not be queued",
      });
    }
  });

  app.post("/api/calls/:id/cancel", { preHandler: app.authenticate }, async (request, reply) => {
    ensureScheduler(request.user.role);
    const { id } = idParams.parse(request.params);
    const existing = await app.db
      .selectFrom("callSessions")
      .selectAll()
      .where("id", "=", id)
      .where("organizationId", "=", request.user.organizationId)
      .executeTakeFirst();
    if (!existing) return reply.code(404).send({ error: "not_found", message: "Call session not found" });
    let providerTerminalStatus: "completed" | "busy" | "failed" | "no_answer" | undefined;
    if (existing.providerCallId && !["completed", "cancelled", "busy", "failed", "no_answer"].includes(existing.status)) {
      try {
        const result = await getCommunicationsProvider(app).cancelCall(existing.providerCallId, request.user.organizationId);
        providerTerminalStatus =
          result.status === "completed"
            ? "completed"
            : result.status === "busy"
              ? "busy"
              : result.status === "failed"
                ? "failed"
                : result.status === "no-answer"
                  ? "no_answer"
                  : undefined;
      } catch (error) {
        // A status callback may have won the race while the cancellation request was in flight.
        const reconciled = await app.db
          .selectFrom("callSessions")
          .select("status")
          .where("id", "=", id)
          .where("organizationId", "=", request.user.organizationId)
          .executeTakeFirst();
        if (!reconciled || !["completed", "cancelled", "busy", "failed", "no_answer"].includes(reconciled.status)) {
          return reply.code(502).send({
            error: "provider_cancellation_failed",
            message: error instanceof Error ? error.message : "The provider could not cancel the active call",
          });
        }
      }
    }
    if (providerTerminalStatus) {
      const reconciled = await app.db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable("callSessions")
          .set({ status: providerTerminalStatus, endedAt: new Date(), updatedAt: new Date() })
          .where("id", "=", id)
          .where("organizationId", "=", request.user.organizationId)
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .updateTable("jobs")
          .set({ status: "cancelled", updatedAt: new Date() })
          .where("organizationId", "=", request.user.organizationId)
          .where("idempotencyKey", "=", `outbound-call:${id}`)
          .where("status", "in", ["pending", "processing"])
          .execute();
        return updated;
      });
      return { call: reconciled };
    }
    const call = await app.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom("callSessions")
        .selectAll()
        .where("id", "=", id)
        .where("organizationId", "=", request.user.organizationId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return undefined;
      if (["completed", "cancelled"].includes(current.status)) return current;
      await trx
        .updateTable("callSessions")
        .set({ status: "cancelled", endedAt: new Date(), outcome: "cancelled_by_scheduler", updatedAt: new Date() })
        .where("id", "=", id)
        .execute();
      await trx
        .updateTable("jobs")
        .set({ status: "cancelled", updatedAt: new Date() })
        .where("organizationId", "=", request.user.organizationId)
        .where("idempotencyKey", "=", `outbound-call:${id}`)
        .where("status", "in", ["pending", "processing"])
        .execute();
      return { ...current, status: "cancelled" as const };
    });
    if (!call) return reply.code(404).send({ error: "not_found", message: "Call session not found" });
    return { call };
  });
};
