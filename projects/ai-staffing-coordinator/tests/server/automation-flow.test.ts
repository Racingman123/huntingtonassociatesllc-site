import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/server/config.js";
import { BOOTSTRAP_ORGANIZATION_ID, ensureBootstrapAdmin } from "../../src/server/db/bootstrap.js";
import type { Database } from "../../src/server/db/types.js";
import { enqueueShiftAutoFill } from "../../src/server/services/scheduling.js";
import { createTestDatabase } from "../helpers/database.js";

describe("fully automated mock scheduling", () => {
  let db: Kysely<Database>;
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "automation-test-secret-longer-than-thirty-two",
      ADMIN_EMAIL: "automation@example.com",
      ADMIN_PASSWORD: "Automation-test-password!",
      COMMUNICATION_PROVIDER: "mock",
      SCHEDULER_ENABLED: "false",
      CONTACT_WINDOW_START_LOCAL: 0,
      CONTACT_WINDOW_END_LOCAL: 24,
      TWILIO_VALIDATE_WEBHOOKS: "false",
      PUBLIC_BASE_URL: "http://localhost:3000",
      LOG_LEVEL: "silent",
    });
    db = await createTestDatabase();
    await ensureBootstrapAdmin(db, config);
    app = await buildApp({ config, db, logger: false });
    await app.ready();

    await db.insertInto("clients").values({
      id: "client-auto",
      organizationId: BOOTSTRAP_ORGANIZATION_ID,
      name: "Automation Client",
      contactName: null,
      contactEmail: null,
      contactPhone: null,
      active: true,
    }).execute();
    await db.insertInto("locations").values({
      id: "location-auto",
      organizationId: BOOTSTRAP_ORGANIZATION_ID,
      clientId: "client-auto",
      name: "Automation Site",
      address: "1 Automation Way",
      timezone: "America/New_York",
      instructions: null,
    }).execute();
    await db.insertInto("workers").values({
      id: "worker-auto",
      organizationId: BOOTSTRAP_ORGANIZATION_ID,
      firstName: "Alex",
      lastName: "Worker",
      phone: "+12035550131",
      email: "alex.worker@example.com",
      status: "active",
      roles: ["Assembler"],
      skills: ["safety"],
      certifications: [],
      availability: {},
      timezone: "America/New_York",
      address: null,
      notes: null,
      voiceConsent: true,
      voiceConsentAt: new Date(),
      voiceConsentSource: "test consent",
      smsConsent: true,
      smsConsentAt: new Date(),
      smsConsentSource: "test consent",
      doNotCall: false,
      doNotText: false,
      lastContactedAt: null,
    }).execute();
    await db.insertInto("shifts").values({
      id: "shift-auto",
      organizationId: BOOTSTRAP_ORGANIZATION_ID,
      clientId: "client-auto",
      locationId: "location-auto",
      role: "Assembler",
      requiredSkills: ["safety"],
      startsAt: new Date(Date.now() + 48 * 60 * 60 * 1_000),
      endsAt: new Date(Date.now() + 56 * 60 * 60 * 1_000),
      headcount: 1,
      payRateCents: 2500,
      status: "open",
      notes: null,
      autoFillEnabled: false,
      autoFillStartedAt: null,
    }).execute();

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "automation@example.com", password: "Automation-test-password!" },
    });
    cookie = login.headers["set-cookie"]!.split(";")[0]!;
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  it("ranks, calls, verifies, and accepts a worker without a live provider", async () => {
    const campaign = await enqueueShiftAutoFill(db, BOOTSTRAP_ORGANIZATION_ID, "shift-auto");
    expect(campaign).not.toBeNull();

    const jobs = await app.inject({
      method: "POST",
      url: "/api/simulator/jobs/run",
      headers: { cookie },
      payload: { limit: 10 },
    });
    expect(jobs.statusCode).toBe(200);

    const call = await db.selectFrom("callSessions").selectAll().where("shiftId", "=", "shift-auto").executeTakeFirstOrThrow();
    expect(call.status).toBe("initiated");
    expect(call.providerCallId).toMatch(/^mock-call-/);

    const answer = await app.inject({
      method: "POST",
      url: `/api/simulator/calls/${call.id}/answer`,
      headers: { cookie },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json().reply).toContain("May I speak with Alex");

    const identity = await app.inject({
      method: "POST",
      url: `/api/simulator/calls/${call.id}/turn`,
      headers: { cookie },
      payload: { speech: "Yes, this is Alex" },
    });
    expect(identity.statusCode).toBe(200);
    expect(identity.json().reply).toContain("Would you like to accept");

    const acceptance = await app.inject({
      method: "POST",
      url: `/api/simulator/calls/${call.id}/turn`,
      headers: { cookie },
      payload: { speech: "Yes, I accept the shift" },
    });
    expect(acceptance.statusCode).toBe(200);
    expect(acceptance.json()).toMatchObject({ endCall: true, outcome: "accepted" });

    const assignment = await db.selectFrom("assignments").selectAll().where("shiftId", "=", "shift-auto").executeTakeFirstOrThrow();
    const shift = await db.selectFrom("shifts").selectAll().where("id", "=", "shift-auto").executeTakeFirstOrThrow();
    expect(assignment.status).toBe("accepted");
    expect(shift.status).toBe("filled");

    const audit = await db.selectFrom("auditLogs").selectAll().where("entityId", "=", assignment.id).execute();
    expect(audit.some((entry) => entry.action === "assignment.accepted")).toBe(true);
  });
});
