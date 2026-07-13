import type { FastifyInstance, InjectOptions } from "fastify";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/server/config.js";
import { ensureBootstrapAdmin } from "../../src/server/db/bootstrap.js";
import type { Database } from "../../src/server/db/types.js";
import { createTestDatabase } from "../helpers/database.js";

describe("authenticated staffing workflow", () => {
  let db: Kysely<Database>;
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-secret-with-more-than-thirty-two-characters",
      ADMIN_EMAIL: "owner@example.com",
      ADMIN_PASSWORD: "A-strong-test-password!",
      COMMUNICATION_PROVIDER: "mock",
      SCHEDULER_ENABLED: "false",
      TWILIO_VALIDATE_WEBHOOKS: "false",
      PUBLIC_BASE_URL: "http://localhost:3000",
      LOG_LEVEL: "silent",
    });
    db = await createTestDatabase();
    await ensureBootstrapAdmin(db, config);
    app = await buildApp({ config, db, logger: false });
    await app.ready();

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "owner@example.com", password: "A-strong-test-password!" },
    });
    expect(login.statusCode).toBe(200);
    cookie = login.headers["set-cookie"]!.split(";")[0]!;
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  const request = (options: InjectOptions) => app.inject({ ...options, headers: { ...options.headers, cookie } });

  it("creates profiles and prevents overbooking and overlaps", async () => {
    const clientResponse = await request({
      method: "POST",
      url: "/api/clients",
      payload: { name: "Test Manufacturing", active: true },
    });
    expect(clientResponse.statusCode).toBe(201);
    const clientId = clientResponse.json().client.id as string;

    const locationResponse = await request({
      method: "POST",
      url: "/api/locations",
      payload: {
        clientId,
        name: "Plant 1",
        address: "1 Test Way, New Haven, CT",
        timezone: "America/New_York",
      },
    });
    expect(locationResponse.statusCode).toBe(201);
    const locationId = locationResponse.json().location.id as string;

    const createWorker = async (firstName: string, phone: string) => {
      const response = await request({
        method: "POST",
        url: "/api/workers",
        payload: {
          firstName,
          lastName: "Tester",
          phone,
          status: "active",
          roles: ["Assembler"],
          skills: ["safety"],
          certifications: [],
          availability: {},
          timezone: "America/New_York",
          voiceConsent: true,
          voiceConsentSource: "test form",
          smsConsent: true,
          smsConsentSource: "test form",
          doNotCall: false,
          doNotText: false,
        },
      });
      expect(response.statusCode).toBe(201);
      return response.json().worker.id as string;
    };
    const firstWorkerId = await createWorker("First", "+12035550121");
    const secondWorkerId = await createWorker("Second", "+12035550122");

    const startsAt = new Date(Date.now() + 48 * 60 * 60 * 1_000);
    const endsAt = new Date(startsAt.getTime() + 8 * 60 * 60 * 1_000);
    const createShift = async (start: Date, end: Date) => {
      const response = await request({
        method: "POST",
        url: "/api/shifts",
        payload: {
          clientId,
          locationId,
          role: "Assembler",
          requiredSkills: ["safety"],
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
          headcount: 1,
          status: "open",
          autoFillEnabled: false,
        },
      });
      expect(response.statusCode).toBe(201);
      return response.json().shift.id as string;
    };
    const firstShiftId = await createShift(startsAt, endsAt);

    const firstAssignment = await request({
      method: "POST",
      url: "/api/assignments",
      payload: { shiftId: firstShiftId, workerId: firstWorkerId, status: "accepted", source: "manual" },
    });
    expect(firstAssignment.statusCode).toBe(201);
    expect(firstAssignment.json().assignment.status).toBe("accepted");

    const fullAssignment = await request({
      method: "POST",
      url: "/api/assignments",
      payload: { shiftId: firstShiftId, workerId: secondWorkerId, status: "accepted", source: "manual" },
    });
    expect(fullAssignment.statusCode).toBe(409);
    expect(fullAssignment.json().error).toBe("shift_full");

    const overlapShiftId = await createShift(
      new Date(startsAt.getTime() + 60 * 60 * 1_000),
      new Date(endsAt.getTime() + 60 * 60 * 1_000),
    );
    const overlappingAssignment = await request({
      method: "POST",
      url: "/api/assignments",
      payload: { shiftId: overlapShiftId, workerId: firstWorkerId, status: "accepted", source: "manual" },
    });
    expect(overlappingAssignment.statusCode).toBe(409);
    expect(overlappingAssignment.json().error).toBe("schedule_conflict");

    const dashboard = await request({ method: "GET", url: "/api/dashboard/summary" });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().activeWorkers).toBe(2);
    expect(dashboard.json().upcomingAssignments).toHaveLength(1);
  });

  it("rejects unauthenticated profile access", async () => {
    const response = await app.inject({ method: "GET", url: "/api/workers" });
    expect(response.statusCode).toBe(401);
  });
});
