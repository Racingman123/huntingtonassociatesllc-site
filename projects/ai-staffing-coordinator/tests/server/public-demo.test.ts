import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/server/config.js";
import { ensureBootstrapAdmin } from "../../src/server/db/bootstrap.js";
import { seedDemoRecords } from "../../src/server/db/seed.js";
import type { Database } from "../../src/server/db/types.js";
import { createTestDatabase } from "../helpers/database.js";

describe("hosted public demo", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    JWT_SECRET: "public-demo-test-secret-that-is-longer-than-32-characters",
    ADMIN_EMAIL: "demo-admin@example.com",
    ADMIN_PASSWORD: "UniquePublicDemoTestPassword1!",
    PUBLIC_BASE_URL: "https://staffing.example.com",
    PUBLIC_DEMO_MODE: "true",
    COMMUNICATION_PROVIDER: "mock",
    SCHEDULER_ENABLED: "false",
    LOG_LEVEL: "silent",
  });
  let db: Kysely<Database>;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = await createTestDatabase();
    await ensureBootstrapAdmin(db, config);
  });

  afterEach(async () => {
    await app?.close();
    await db.destroy();
  });

  it("idempotently restores fictional records on a fresh or existing database", async () => {
    await seedDemoRecords(db, config, { refreshExisting: true });
    await db.updateTable("workers").set({ notes: "changed" }).where("id", "=", "wrk_ava").execute();
    await db.updateTable("shifts").set({ status: "cancelled" }).where("id", "=", "shf_banquet_demo").execute();
    await seedDemoRecords(db, config, { refreshExisting: true });

    expect(await db.selectFrom("clients").select("id").execute()).toEqual([{ id: "cli_harbor" }]);
    expect(await db.selectFrom("locations").select("id").execute()).toEqual([{ id: "loc_harbor_hotel" }]);
    expect(await db.selectFrom("workers").select((eb) => eb.fn.countAll().as("count")).executeTakeFirstOrThrow())
      .toMatchObject({ count: 4 });
    expect(await db.selectFrom("workers").select("notes").where("id", "=", "wrk_ava").executeTakeFirstOrThrow())
      .toEqual({ notes: "Fictional demo worker" });
    const shift = await db.selectFrom("shifts").selectAll().where("id", "=", "shf_banquet_demo").executeTakeFirstOrThrow();
    expect(shift.status).toBe("open");
    expect(new Date(shift.startsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("registers production simulator routes and can repeat the same scenario", async () => {
    await seedDemoRecords(db, config, { refreshExisting: true });
    app = await buildApp({ config, db, logger: false });
    await app.ready();

    const provider = await app.inject({ method: "GET", url: "/api/simulator/provider-events" });
    expect(provider.statusCode).toBe(200);
    expect(provider.json().provider).toBe("mock");

    const run = () => app.inject({
      method: "POST",
      url: "/api/demo/simulate",
      payload: { workerId: "wrk_ava", shiftId: "shf_banquet_demo", response: "accept" },
    });
    const first = await run();
    const second = await run();
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().simulation.callId).not.toBe(second.json().simulation.callId);

    const calls = await db.selectFrom("callSessions").selectAll()
      .where("organizationId", "=", "org_default").where("shiftId", "=", "shf_banquet_demo").execute();
    const assignments = await db.selectFrom("assignments").selectAll()
      .where("organizationId", "=", "org_default").where("shiftId", "=", "shf_banquet_demo").execute();
    expect(calls).toHaveLength(2);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.status).toBe("accepted");
  });
});
