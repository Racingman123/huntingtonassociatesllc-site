import { afterEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type { Kysely } from "kysely";
import type { Database, Shift, Worker } from "../../src/server/db/types.js";
import { acceptAssignment, evaluateWorkerEligibility } from "../../src/server/services/scheduling.js";
import { createTestDatabase } from "../helpers/database.js";

const now = new Date();

function worker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: "worker",
    organizationId: "org",
    firstName: "Ada",
    lastName: "Lovelace",
    phone: "+12035550123",
    email: null,
    status: "active",
    roles: ["Server"],
    skills: ["food-safety"],
    certifications: [],
    availability: {},
    timezone: "America/New_York",
    address: null,
    notes: null,
    voiceConsent: true,
    voiceConsentAt: now,
    voiceConsentSource: "test",
    smsConsent: true,
    smsConsentAt: now,
    smsConsentSource: "test",
    doNotCall: false,
    doNotText: false,
    lastContactedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function shift(overrides: Partial<Shift> = {}): Shift {
  return {
    id: "shift",
    organizationId: "org",
    clientId: "client",
    locationId: "location",
    role: "Server",
    requiredSkills: ["food-safety"],
    startsAt: DateTime.utc().plus({ days: 2 }).set({ hour: 14 }).toJSDate(),
    endsAt: DateTime.utc().plus({ days: 2 }).set({ hour: 20 }).toJSDate(),
    headcount: 1,
    payRateCents: 2000,
    status: "open",
    notes: null,
    autoFillEnabled: false,
    autoFillStartedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("worker eligibility", () => {
  it("requires role, skills, consent and no scheduling conflict", () => {
    expect(evaluateWorkerEligibility(worker(), shift()).eligible).toBe(true);
    expect(evaluateWorkerEligibility(worker({ roles: ["Cook"] }), shift()).reasons).toContain("role_mismatch");
    expect(evaluateWorkerEligibility(worker({ voiceConsent: false }), shift()).reasons).toContain("not_voice_contactable");
    expect(evaluateWorkerEligibility(worker(), shift(), { hasConflict: true }).reasons).toContain("schedule_conflict");
  });

  it("honors worker-local availability", () => {
    const target = shift({
      startsAt: DateTime.fromISO("2030-01-07T14:00:00", { zone: "America/New_York" }).toUTC().toJSDate(),
      endsAt: DateTime.fromISO("2030-01-07T18:00:00", { zone: "America/New_York" }).toUTC().toJSDate(),
    });
    expect(evaluateWorkerEligibility(worker({ availability: { monday: [{ start: "13:00", end: "19:00" }] } }), target).eligible).toBe(true);
    expect(evaluateWorkerEligibility(worker({ availability: { monday: [{ start: "15:00", end: "19:00" }] } }), target).reasons).toContain("outside_availability");
  });
});

describe("assignment acceptance invariants", () => {
  let db: Kysely<Database> | undefined;

  afterEach(async () => db?.destroy());

  async function setup() {
    db = await createTestDatabase();
    await db.insertInto("organizations").values({ id: "org", name: "Test", timezone: "America/New_York" }).execute();
    await db.insertInto("clients").values({ id: "client", organizationId: "org", name: "Client", contactName: null, contactEmail: null, contactPhone: null, active: true }).execute();
    await db.insertInto("locations").values({ id: "location", organizationId: "org", clientId: "client", name: "Main", address: "1 Main St", timezone: "America/New_York", instructions: null }).execute();
    for (const [index, id] of ["w1", "w2", "w3"].entries()) await db.insertInto("workers").values({
      ...worker({ id, phone: `+1203555012${index}` }), createdAt: undefined, updatedAt: undefined,
    }).execute();
    const startsAt = DateTime.utc().plus({ days: 3 }).startOf("hour").toJSDate();
    const endsAt = DateTime.fromJSDate(startsAt).plus({ hours: 8 }).toJSDate();
    for (const id of ["s1", "s2"]) await db.insertInto("shifts").values({ ...shift({ id, startsAt, endsAt }), createdAt: undefined, updatedAt: undefined }).execute();
    return db;
  }

  it("never accepts beyond shift capacity", async () => {
    const database = await setup();
    await database.insertInto("assignments").values([
      { id: "a1", organizationId: "org", shiftId: "s1", workerId: "w1", status: "offered", offeredAt: now, acceptedAt: null, declinedAt: null, declineReason: null, source: "manual" },
      { id: "a2", organizationId: "org", shiftId: "s1", workerId: "w2", status: "offered", offeredAt: now, acceptedAt: null, declinedAt: null, declineReason: null, source: "manual" },
    ]).execute();
    const results = await Promise.all([
      acceptAssignment(database, "org", "a1"),
      acceptAssignment(database, "org", "a2"),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ code: "shift_full" });
  });

  it("prevents one worker accepting overlapping shifts", async () => {
    const database = await setup();
    await database.updateTable("shifts").set({ headcount: 2 }).execute();
    await database.insertInto("assignments").values([
      { id: "a1", organizationId: "org", shiftId: "s1", workerId: "w3", status: "offered", offeredAt: now, acceptedAt: null, declinedAt: null, declineReason: null, source: "voice" },
      { id: "a2", organizationId: "org", shiftId: "s2", workerId: "w3", status: "offered", offeredAt: now, acceptedAt: null, declinedAt: null, declineReason: null, source: "voice" },
    ]).execute();
    const first = await acceptAssignment(database, "org", "a1");
    const second = await acceptAssignment(database, "org", "a2");
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, code: "schedule_conflict" });
  });
});
