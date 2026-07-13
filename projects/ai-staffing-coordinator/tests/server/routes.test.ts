import bcrypt from "bcryptjs";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { buildApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/server/config.js";
import { BOOTSTRAP_ORGANIZATION_ID, ensureBootstrapAdmin } from "../../src/server/db/bootstrap.js";
import type { Database } from "../../src/server/db/types.js";
import { createTestDatabase } from "../helpers/database.js";

const testConfig = loadConfig({
  NODE_ENV: "test",
  JWT_SECRET: "test-secret-at-least-sixteen-characters",
  ADMIN_EMAIL: "admin@test.example",
  ADMIN_PASSWORD: "StrongTestPassword1!",
  SCHEDULER_ENABLED: "false",
  COMMUNICATION_PROVIDER: "mock",
  LOG_LEVEL: "silent",
});
const publicDemoConfig = loadConfig({
  NODE_ENV: "test",
  JWT_SECRET: "test-secret-at-least-sixteen-characters",
  ADMIN_EMAIL: "admin@test.example",
  ADMIN_PASSWORD: "StrongTestPassword1!",
  PUBLIC_DEMO_MODE: "true",
  SCHEDULER_ENABLED: "false",
  COMMUNICATION_PROVIDER: "mock",
  LOG_LEVEL: "silent",
});

describe("authenticated tenant routes", () => {
  let db: Kysely<Database> | undefined;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    await db?.destroy();
  });

  async function setup(config = testConfig, login = true) {
    db = await createTestDatabase();
    await ensureBootstrapAdmin(db, config);
    await db.insertInto("organizations").values({ id: "other-org", name: "Other", timezone: "America/New_York" }).execute();
    for (const [id, organizationId, phone] of [
      ["visible-worker", BOOTSTRAP_ORGANIZATION_ID, "+12035550111"],
      ["hidden-worker", "other-org", "+12035550112"],
    ] as const) {
      await db.insertInto("workers").values({
        id, organizationId, firstName: id, lastName: "Test", phone, email: null, status: "active",
        roles: [], skills: [], certifications: [], availability: {}, timezone: "America/New_York",
        address: null, notes: null, voiceConsent: false, voiceConsentAt: null, voiceConsentSource: null,
        smsConsent: false, smsConsentAt: null, smsConsentSource: null, doNotCall: false, doNotText: false, lastContactedAt: null,
      }).execute();
    }
    app = await buildApp({ db, config, logger: false });
    await app.ready();
    if (!login) return "";
    const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD } });
    expect(response.statusCode).toBe(200);
    return String(response.headers["set-cookie"]);
  }

  it("authenticates with an HTTP-only cookie and scopes reads to its tenant", async () => {
    const cookie = await setup();
    expect(cookie).toContain("HttpOnly");
    const response = await app!.inject({ method: "GET", url: "/api/workers", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().workers.map((worker: { id: string }) => worker.id)).toEqual(["visible-worker"]);
  });

  it("rejects unauthenticated reads and viewer writes", async () => {
    await setup();
    expect((await app!.inject({ method: "GET", url: "/api/workers" })).statusCode).toBe(401);
    await db!.insertInto("users").values({
      id: "viewer", organizationId: BOOTSTRAP_ORGANIZATION_ID, email: "viewer@test.example",
      passwordHash: await bcrypt.hash("ViewerPassword1!", 4), name: "Viewer", role: "viewer", active: true,
    }).execute();
    const login = await app!.inject({ method: "POST", url: "/api/auth/login", payload: { email: "viewer@test.example", password: "ViewerPassword1!" } });
    const response = await app!.inject({
      method: "POST", url: "/api/workers", headers: { cookie: String(login.headers["set-cookie"]) },
      payload: { firstName: "New", lastName: "Worker", phone: "+12035550199" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("uses a fixed bootstrap-tenant identity in public demo mode without accepting login", async () => {
    await setup(publicDemoConfig, false);

    const me = await app!.inject({ method: "GET", url: "/api/auth/me" });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({
      id: "public-demo",
      organizationId: BOOTSTRAP_ORGANIZATION_ID,
      name: "Portfolio Demo",
      role: "scheduler",
      publicDemo: true,
    });

    const forgedOtherTenantToken = app!.jwt.sign({
      sub: "forged-user",
      organizationId: "other-org",
      email: "forged@example.com",
      name: "Forged User",
      role: "admin",
    });
    const workers = await app!.inject({
      method: "GET",
      url: "/api/workers",
      headers: { authorization: `Bearer ${forgedOtherTenantToken}` },
    });
    expect(workers.statusCode).toBe(200);
    expect(workers.json().workers.map((worker: { id: string }) => worker.id)).toEqual(["visible-worker"]);

    const created = await app!.inject({
      method: "POST",
      url: "/api/workers",
      payload: {
        firstName: "Demo",
        lastName: "Visitor",
        phone: "+12035550198",
        organizationId: "other-org",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().worker.organizationId).toBe(BOOTSTRAP_ORGANIZATION_ID);
    expect(await db!.selectFrom("workers").select("id").where("organizationId", "=", "other-org").execute())
      .toEqual([{ id: "hidden-worker" }]);

    const login = await app!.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: publicDemoConfig.ADMIN_EMAIL, password: publicDemoConfig.ADMIN_PASSWORD },
    });
    expect(login.statusCode).toBe(403);
    expect(login.json().error).toBe("public_demo_mode");

    const logout = await app!.inject({ method: "POST", url: "/api/auth/logout" });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers["set-cookie"]).toBeUndefined();
  });
});
