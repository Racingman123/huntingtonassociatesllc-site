import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getCommunicationsProvider } from "../services/communications.js";
import { processReminderJobsOnce, queueOutboundCall } from "../services/reminder-worker.js";
import { acceptAssignment, declineAssignment } from "../services/scheduling.js";
import { initializeIdentityCheck, recordConversationTurn, runVoiceTurn } from "../services/voice-agent.js";

const callParams = z.object({ callSessionId: z.string().min(1) });
const turnBody = z.object({ speech: z.string().max(2_000) }).strict();
const demoBody = z
  .object({
    workerId: z.string().min(1),
    shiftId: z.string().min(1),
    response: z.enum(["accept", "decline", "no_answer", "busy"]),
  })
  .strict();

async function resetPublicDemoShift(app: Parameters<FastifyPluginAsync>[0], organizationId: string, shiftId: string): Promise<void> {
  await app.db.transaction().execute(async (trx) => {
    const shift = await trx.selectFrom("shifts").selectAll()
      .where("id", "=", shiftId).where("organizationId", "=", organizationId)
      .forUpdate().executeTakeFirst();
    if (!shift) return;

    const activeCalls = await trx.selectFrom("callSessions").select("id")
      .where("organizationId", "=", organizationId).where("shiftId", "=", shiftId)
      .where("status", "in", ["queued", "initiated", "ringing", "in_progress"])
      .execute();
    if (activeCalls.length) {
      const callIds = activeCalls.map((call) => call.id);
      await trx.updateTable("jobs").set({ status: "cancelled" })
        .where("organizationId", "=", organizationId)
        .where("idempotencyKey", "in", callIds.map((id) => `outbound-call:${id}`))
        .where("status", "in", ["pending", "processing"])
        .execute();
      await trx.updateTable("callSessions").set({
        status: "cancelled",
        endedAt: new Date(),
        outcome: "public_demo_reset",
      }).where("organizationId", "=", organizationId).where("id", "in", callIds).execute();
    }

    // A public portfolio visit demonstrates one isolated scheduling outcome at a
    // time. Clearing offers makes the same worker/shift scenario repeatable.
    await trx.deleteFrom("assignments")
      .where("organizationId", "=", organizationId).where("shiftId", "=", shiftId)
      .execute();

    const startsAt = new Date(shift.startsAt);
    const duration = Math.max(60 * 60_000, new Date(shift.endsAt).getTime() - startsAt.getTime());
    const nextStart = startsAt.getTime() > Date.now() ? startsAt : new Date(Date.now() + 48 * 60 * 60_000);
    await trx.updateTable("shifts").set({
      status: "open",
      startsAt: nextStart,
      endsAt: new Date(nextStart.getTime() + duration),
      autoFillEnabled: false,
      autoFillStartedAt: null,
    }).where("id", "=", shift.id).where("organizationId", "=", organizationId).execute();
  });
}

/** Safe simulation routes for development and mock-only public portfolio deployments. */
export const simulatorRoutes: FastifyPluginAsync = async (app) => {
  if (app.config.NODE_ENV === "production" && !app.config.PUBLIC_DEMO_MODE) return;
  app.addHook("preHandler", app.authenticate);

  app.get("/api/simulator/provider-events", async (request) => ({
    provider: getCommunicationsProvider(app).kind,
    // Provider events have no tenant claim, so expose only non-sensitive delivery metadata.
    events: (getCommunicationsProvider(app).getEvents?.() ?? [])
      .filter((event) => event.organizationId === request.user.organizationId)
      .map((event) => ({ type: event.type, at: event.at, id: event.id, status: event.status })),
  }));

  app.post("/api/simulator/jobs/run", async (request) => {
    const body = z.object({ limit: z.number().int().min(1).max(100).default(20) }).parse(request.body ?? {});
    const processed = await processReminderJobsOnce(app, body.limit, request.user.organizationId);
    return { processed };
  });

  app.post("/api/demo/simulate", async (request, reply) => {
    if (request.user.role === "viewer") {
      return reply.code(403).send({ error: "forbidden", message: "Scheduler or administrator access is required" });
    }
    const body = demoBody.parse(request.body);
    try {
      if (app.config.PUBLIC_DEMO_MODE) {
        await resetPublicDemoShift(app, request.user.organizationId, body.shiftId);
      }
      const queued = await queueOutboundCall(app, {
        organizationId: request.user.organizationId,
        workerId: body.workerId,
        shiftId: body.shiftId,
      });
      const call = await app.db
        .selectFrom("callSessions")
        .selectAll()
        .where("id", "=", queued.callSessionId)
        .where("organizationId", "=", request.user.organizationId)
        .executeTakeFirstOrThrow();
      if (!call.assignmentId) throw new Error("Simulated call has no assignment");

      await app.db
        .updateTable("jobs")
        .set({ status: "cancelled" })
        .where("organizationId", "=", request.user.organizationId)
        .where("idempotencyKey", "=", `outbound-call:${call.id}`)
        .where("status", "in", ["pending", "processing"])
        .execute();
      await recordConversationTurn(
        app.db,
        { callSessionId: call.id, organizationId: request.user.organizationId },
        "agent",
        `${app.config.AGENT_DISCLOSURE} This is a safe local simulation.`,
      );

      const now = new Date();
      let status: "completed" | "no_answer" | "busy" = "completed";
      let outcome: string = body.response;
      let message: string;
      if (body.response === "accept") {
        await recordConversationTurn(app.db, { callSessionId: call.id, organizationId: request.user.organizationId }, "worker", "Yes, I accept the shift.");
        const result = await acceptAssignment(app.db, request.user.organizationId, call.assignmentId, {
          actorType: "user",
          actorId: request.user.sub,
          actorLabel: `${request.user.name} via simulator`,
          metadata: { callSessionId: call.id, simulated: true },
        });
        if (!result.ok) throw new Error(result.message);
        message = "The simulated worker accepted the shift.";
      } else if (body.response === "decline") {
        await recordConversationTurn(app.db, { callSessionId: call.id, organizationId: request.user.organizationId }, "worker", "No, I cannot work that shift.");
        const result = await declineAssignment(app.db, request.user.organizationId, call.assignmentId, "Declined in simulator", {
          actorType: "user",
          actorId: request.user.sub,
          actorLabel: `${request.user.name} via simulator`,
          metadata: { callSessionId: call.id, simulated: true },
        });
        if (!result.ok) throw new Error(result.message);
        message = "The simulated worker declined the shift.";
      } else if (body.response === "no_answer") {
        status = "no_answer";
        outcome = "no_answer";
        message = "The simulated call was not answered.";
      } else {
        status = "busy";
        outcome = "busy";
        message = "The simulated worker's line was busy.";
      }
      await recordConversationTurn(
        app.db,
        { callSessionId: call.id, organizationId: request.user.organizationId },
        "system",
        message,
      );
      await app.db
        .updateTable("callSessions")
        .set({ status, attempt: 1, startedAt: now, endedAt: now, outcome })
        .where("id", "=", call.id)
        .where("organizationId", "=", request.user.organizationId)
        .execute();
      if (body.response === "accept" || body.response === "decline") {
        await app.db.updateTable("assignments").set({ source: "voice" })
          .where("id", "=", call.assignmentId)
          .where("organizationId", "=", request.user.organizationId)
          .execute();
      }
      return {
        simulation: {
          callId: call.id,
          assignmentId: call.assignmentId,
          status,
          message,
        },
      };
    } catch (error) {
      return reply.code(409).send({
        error: "simulation_failed",
        message: error instanceof Error ? error.message : "The simulation could not be completed",
      });
    }
  });

  app.post("/api/simulator/calls/:callSessionId/answer", async (request, reply) => {
    const { callSessionId } = callParams.parse(request.params);
    try {
      const owned = await app.db
        .selectFrom("callSessions")
        .select("id")
        .where("id", "=", callSessionId)
        .where("organizationId", "=", request.user.organizationId)
        .executeTakeFirst();
      if (!owned) throw new Error("Call session not found");
      const result = await initializeIdentityCheck(
        app.db,
        callSessionId,
        app.config.COMPANY_DISPLAY_NAME,
        app.config.AGENT_DISCLOSURE,
      );
      await app.db
        .updateTable("callSessions")
        .set({ status: "in_progress", disclosurePlayedAt: new Date(), startedAt: new Date(), updatedAt: new Date() })
        .where("id", "=", callSessionId)
        .execute();
      return { callSessionId, reply: result.prompt, endCall: false };
    } catch {
      return reply.code(404).send({ error: "not_found", message: "Call session not found" });
    }
  });

  app.post("/api/simulator/calls/:callSessionId/turn", async (request, reply) => {
    const { callSessionId } = callParams.parse(request.params);
    const { speech } = turnBody.parse(request.body);
    try {
      const owned = await app.db
        .selectFrom("callSessions")
        .select("id")
        .where("id", "=", callSessionId)
        .where("organizationId", "=", request.user.organizationId)
        .executeTakeFirst();
      if (!owned) throw new Error("Call session not found");
      const result = await runVoiceTurn({ db: app.db, config: app.config, callSessionId }, speech);
      if (result.endCall) {
        await app.db
          .updateTable("callSessions")
          .set({ status: "completed", endedAt: new Date(), ...(result.outcome ? { outcome: result.outcome } : {}) })
          .where("id", "=", callSessionId)
          .execute();
      }
      return result;
    } catch {
      return reply.code(404).send({ error: "not_found", message: "Call session not found" });
    }
  });
};
