import type { FastifyPluginAsync, FastifyRequest } from "fastify";

export async function getDashboardSummary(app: Parameters<FastifyPluginAsync>[0], request: FastifyRequest) {
  const organizationId = request.user.organizationId;
  const now = new Date();
  const todayUtc = new Date(now);
  todayUtc.setUTCHours(0, 0, 0, 0);

  const [activeWorkersRow, openShifts, callsTodayRow, upcomingRows, recentActivity] = await Promise.all([
    app.db.selectFrom("workers").select((eb) => eb.fn.countAll().as("count"))
      .where("organizationId", "=", organizationId).where("status", "=", "active").executeTakeFirstOrThrow(),
    app.db.selectFrom("shifts as s").select(["s.id", "s.headcount"])
      .select((eb) => eb.selectFrom("assignments as a").select((countEb) => countEb.fn.countAll<number>().as("count"))
        .whereRef("a.shiftId", "=", "s.id").where("a.organizationId", "=", organizationId)
        .where("a.status", "=", "accepted").as("acceptedCount"))
      .where("s.organizationId", "=", organizationId).where("s.status", "=", "open")
      .where("s.startsAt", ">", now).execute(),
    app.db.selectFrom("callSessions").select((eb) => eb.fn.countAll().as("count"))
      .where("organizationId", "=", organizationId).where("createdAt", ">=", todayUtc).executeTakeFirstOrThrow(),
    app.db.selectFrom("assignments as a").innerJoin("workers as w", "w.id", "a.workerId")
      .innerJoin("shifts as s", "s.id", "a.shiftId").select([
        "a.id", "a.workerId", "a.shiftId", "a.status", "a.acceptedAt", "a.declineReason",
        "w.firstName", "w.lastName", "s.role as shiftRole", "s.startsAt as shiftStartsAt",
      ]).where("a.organizationId", "=", organizationId).where("a.status", "=", "accepted")
      .where("s.startsAt", ">=", now).orderBy("s.startsAt").limit(10).execute(),
    app.db.selectFrom("auditLogs").select(["id", "action", "entityType", "createdAt", "actorLabel"])
      .where("organizationId", "=", organizationId).orderBy("createdAt", "desc").limit(20).execute(),
  ]);

  return {
    activeWorkers: Number(activeWorkersRow.count),
    openShifts: openShifts.length,
    unfilledPositions: openShifts.reduce((total, shift) => total + Math.max(0, shift.headcount - Number(shift.acceptedCount)), 0),
    callsToday: Number(callsTodayRow.count),
    upcomingAssignments: upcomingRows.map(({ firstName, lastName, ...assignment }) => ({
      ...assignment,
      workerName: `${firstName} ${lastName}`,
    })),
    recentActivity,
  };
}

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.get("/dashboard", async (request) => getDashboardSummary(app, request));
  app.get("/dashboard/summary", async (request) => getDashboardSummary(app, request));
};
