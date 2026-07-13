import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { loadConfig } from "../../src/server/config.js";
import type { Database } from "../../src/server/db/types.js";
import { buildVoiceTwiml } from "../../src/server/routes/webhooks.js";
import { createCommunicationsProvider } from "../../src/server/services/communications.js";
import { inferVoiceIntent } from "../../src/server/services/voice-agent.js";
import { nextAllowedContactAt, processReminderJobsOnce } from "../../src/server/services/reminder-worker.js";
import { createTestDatabase } from "../helpers/database.js";

describe("communications workflow", () => {
  let db: Kysely<Database> | undefined;
  let app: ReturnType<typeof Fastify> | undefined;

  afterEach(async () => {
    await app?.close();
    await db?.destroy();
  });

  it("uses narrow deterministic intents when AI is unavailable", () => {
    expect(inferVoiceIntent("Yes, sign me up")).toEqual({ name: "accept_shift", args: {} });
    expect(inferVoiceIntent("No, I can't work then")?.name).toBe("decline_shift");
    expect(inferVoiceIntent("I'd like a human to call me back")?.name).toBe("request_callback");
    expect(inferVoiceIntent("What is the weather?")).toBeNull();
  });

  it("renders escaped TwiML with a speech and keypad Gather turn", () => {
    const xml = buildVoiceTwiml("A & B <staffing>", "/webhooks/twilio/voice/call-1/turn");
    expect(xml).toContain("<Gather");
    expect(xml).toContain('input="speech dtmf"');
    expect(xml).toContain("A &amp; B &lt;staffing&gt;");
    expect(xml).not.toContain("<Record");
  });

  it("keeps mock calls, messages, and cancellations observable without network access", async () => {
    const config = loadConfig({ NODE_ENV: "test", COMMUNICATION_PROVIDER: "mock" });
    const provider = createCommunicationsProvider(config);
    const call = await provider.createCall({ to: "+12025550100", answerUrl: "https://example.test/voice", statusCallbackUrl: "https://example.test/status" });
    await provider.sendSms({ to: "+12025550100", body: "Test reminder" });
    await provider.cancelCall(call.id);
    expect(provider.getEvents?.().map((event) => event.type)).toEqual(["call", "sms", "call_cancel"]);
  });

  it("defers contacts to the worker-local allowed window", () => {
    const config = loadConfig({ NODE_ENV: "test", CONTACT_WINDOW_START_LOCAL: 8, CONTACT_WINDOW_END_LOCAL: 20 });
    const beforeWindow = new Date("2026-01-15T11:00:00.000Z"); // 06:00 America/New_York
    expect(nextAllowedContactAt(config, "America/New_York", beforeWindow).toISOString()).toBe("2026-01-15T13:00:00.000Z");
  });

  it("suppresses non-consented reminders once and completes the idempotent job", async () => {
    db = await createTestDatabase();
    app = Fastify({ logger: false });
    const config = loadConfig({ NODE_ENV: "test", COMMUNICATION_PROVIDER: "mock", SCHEDULER_ENABLED: "false" });
    app.decorate("db", db);
    app.decorate("config", config);

    const startsAt = new Date(Date.now() + 4 * 60 * 60_000);
    await db.insertInto("organizations").values({ id: "org", name: "Test Staffing", timezone: "America/New_York" }).execute();
    await db.insertInto("workers").values({
      id: "worker",
      organizationId: "org",
      firstName: "Ada",
      lastName: "Worker",
      phone: "+12025550100",
      email: null,
      status: "active",
      roles: ["Nurse"],
      skills: [],
      certifications: [],
      availability: {},
      timezone: "America/New_York",
      address: null,
      notes: null,
      voiceConsent: true,
      voiceConsentAt: new Date(),
      voiceConsentSource: "test",
      smsConsent: false,
      smsConsentAt: null,
      smsConsentSource: null,
      doNotCall: false,
      doNotText: false,
      lastContactedAt: null,
    }).execute();
    await db.insertInto("clients").values({ id: "client", organizationId: "org", name: "Hospital", contactName: null, contactEmail: null, contactPhone: null }).execute();
    await db.insertInto("locations").values({ id: "location", organizationId: "org", clientId: "client", name: "Main", address: "1 Main St", timezone: "America/New_York", instructions: null }).execute();
    await db.insertInto("shifts").values({
      id: "shift",
      organizationId: "org",
      clientId: "client",
      locationId: "location",
      role: "Nurse",
      requiredSkills: [],
      startsAt,
      endsAt: new Date(startsAt.getTime() + 8 * 60 * 60_000),
      headcount: 1,
      payRateCents: null,
      status: "filled",
      notes: null,
      autoFillEnabled: false,
      autoFillStartedAt: null,
    }).execute();
    await db.insertInto("assignments").values({
      id: "assignment",
      organizationId: "org",
      shiftId: "shift",
      workerId: "worker",
      status: "accepted",
      offeredAt: new Date(),
      acceptedAt: new Date(),
      declinedAt: null,
      declineReason: null,
      source: "manual",
    }).execute();
    await db.insertInto("jobs").values({
      id: "job",
      organizationId: "org",
      type: "shift_reminder",
      status: "pending",
      runAt: new Date(Date.now() - 1_000),
      payload: { assignmentId: "assignment", offsetMinutes: 120 },
      idempotencyKey: "shift-reminder:assignment:120",
      attempts: 0,
      maxAttempts: 3,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      completedAt: null,
    }).execute();

    expect(await processReminderJobsOnce(app, 10)).toBe(1);
    expect(await processReminderJobsOnce(app, 10)).toBe(0);
    const messages = await db.selectFrom("messages").select(["status", "errorMessage"]).execute();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.status).toBe("suppressed");
    expect((await db.selectFrom("jobs").select("status").where("id", "=", "job").executeTakeFirstOrThrow()).status).toBe("completed");
  });

  it("turns an auto-fill campaign tick into a qualified outbound call", async () => {
    db = await createTestDatabase();
    app = Fastify({ logger: false });
    const config = loadConfig({
      NODE_ENV: "test",
      COMMUNICATION_PROVIDER: "mock",
      SCHEDULER_ENABLED: "false",
      CONTACT_WINDOW_START_LOCAL: 0,
      CONTACT_WINDOW_END_LOCAL: 24,
    });
    app.decorate("db", db);
    app.decorate("config", config);

    const startsAt = new Date(Date.now() + 24 * 60 * 60_000);
    await db.insertInto("organizations").values({ id: "org-auto", name: "Auto Staffing", timezone: "UTC" }).execute();
    await db.insertInto("workers").values({
      id: "worker-auto",
      organizationId: "org-auto",
      firstName: "Grace",
      lastName: "Worker",
      phone: "+12025550101",
      email: null,
      status: "active",
      roles: ["Nurse"],
      skills: ["BLS"],
      certifications: [],
      availability: {},
      timezone: "UTC",
      address: null,
      notes: null,
      voiceConsent: true,
      voiceConsentAt: new Date(),
      voiceConsentSource: "test",
      smsConsent: false,
      smsConsentAt: null,
      smsConsentSource: null,
      doNotCall: false,
      doNotText: false,
      lastContactedAt: null,
    }).execute();
    await db.insertInto("clients").values({ id: "client-auto", organizationId: "org-auto", name: "Clinic", contactName: null, contactEmail: null, contactPhone: null }).execute();
    await db.insertInto("locations").values({ id: "location-auto", organizationId: "org-auto", clientId: "client-auto", name: "North", address: "2 Main St", timezone: "UTC", instructions: null }).execute();
    await db.insertInto("shifts").values({
      id: "shift-auto",
      organizationId: "org-auto",
      clientId: "client-auto",
      locationId: "location-auto",
      role: "Nurse",
      requiredSkills: ["BLS"],
      startsAt,
      endsAt: new Date(startsAt.getTime() + 8 * 60 * 60_000),
      headcount: 1,
      payRateCents: null,
      status: "open",
      notes: null,
      autoFillEnabled: true,
      autoFillStartedAt: new Date(),
    }).execute();
    await db.insertInto("jobs").values({
      id: "campaign",
      organizationId: "org-auto",
      type: "campaign_tick",
      status: "pending",
      runAt: new Date(Date.now() - 1_000),
      payload: { shiftId: "shift-auto" },
      idempotencyKey: "autofill:shift-auto:test",
      attempts: 0,
      maxAttempts: 3,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      completedAt: null,
    }).execute();

    expect(await processReminderJobsOnce(app, 10)).toBe(2);
    const call = await db.selectFrom("callSessions").select(["status", "providerCallId", "attempt"]).executeTakeFirstOrThrow();
    expect(call.status).toBe("initiated");
    expect(call.providerCallId).toMatch(/^mock-call-/);
    expect(call.attempt).toBe(1);
  });
});
