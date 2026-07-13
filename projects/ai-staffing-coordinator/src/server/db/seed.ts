import { DateTime } from "luxon";
import type { Kysely } from "kysely";
import { config } from "../config.js";
import type { AppConfig } from "../config.js";
import { BOOTSTRAP_ORGANIZATION_ID, ensureBootstrapAdmin } from "./bootstrap.js";
import { createDatabase } from "./database.js";
import { migrateToLatest } from "./migrator.js";
import type { Database } from "./types.js";

export interface DemoSeedOptions {
  /** Restore the fixed fictional records and move the demo shift into the future. */
  refreshExisting?: boolean;
}

/**
 * Load only fictional, non-routable portfolio data into the bootstrap tenant.
 * This is safe to call more than once and is reused by local and hosted demos.
 */
export async function seedDemoRecords(
  db: Kysely<Database>,
  appConfig: AppConfig,
  options: DemoSeedOptions = {},
): Promise<void> {
  const now = new Date();
  const organizationId = BOOTSTRAP_ORGANIZATION_ID;

  const client = {
    id: "cli_harbor",
    organizationId,
    name: "Harbor Hospitality",
    contactName: "Morgan Lee",
    contactEmail: "morgan@example.com",
    contactPhone: "+12035550180",
    active: true,
  };
  await db.insertInto("clients").values(client).onConflict((oc) => options.refreshExisting
    ? oc.column("id").doUpdateSet({
        name: client.name,
        contactName: client.contactName,
        contactEmail: client.contactEmail,
        contactPhone: client.contactPhone,
        active: client.active,
      })
    : oc.column("id").doNothing()).execute();

  const location = {
    id: "loc_harbor_hotel",
    organizationId,
    clientId: client.id,
    name: "Harbor Hotel",
    address: "100 Water Street, New Haven, CT 06510",
    timezone: appConfig.DEFAULT_TIMEZONE,
    instructions: "Use the employee entrance on Crown Street and check in with security.",
  };
  await db.insertInto("locations").values(location).onConflict((oc) => options.refreshExisting
    ? oc.column("id").doUpdateSet({
        clientId: location.clientId,
        name: location.name,
        address: location.address,
        timezone: location.timezone,
        instructions: location.instructions,
      })
    : oc.column("id").doNothing()).execute();

  const fullAvailability = {
    monday: [{ start: "00:00", end: "23:59" }],
    tuesday: [{ start: "00:00", end: "23:59" }],
    wednesday: [{ start: "00:00", end: "23:59" }],
    thursday: [{ start: "00:00", end: "23:59" }],
    friday: [{ start: "00:00", end: "23:59" }],
    saturday: [{ start: "00:00", end: "23:59" }],
    sunday: [{ start: "00:00", end: "23:59" }],
  };
  const workers = [
    ["wrk_ava", "Ava", "Martinez", "+12035550101", ["Banquet Server", "Server"], ["food-safety", "customer-service"]],
    ["wrk_jamal", "Jamal", "Reed", "+12035550102", ["Banquet Server", "Bartender"], ["food-safety", "bartending"]],
    ["wrk_priya", "Priya", "Shah", "+12035550103", ["Banquet Server", "Server"], ["food-safety", "customer-service"]],
    ["wrk_luis", "Luis", "Rivera", "+12035550104", ["Dishwasher", "Prep Cook"], ["food-safety"]],
  ] as const;
  for (const [id, firstName, lastName, phone, roles, skills] of workers) {
    const worker = {
      id,
      organizationId,
      firstName,
      lastName,
      phone,
      email: `${firstName.toLowerCase()}@example.com`,
      status: "active" as const,
      roles: [...roles],
      skills: [...skills],
      certifications: [{ name: "food-safety", expiresAt: DateTime.utc().plus({ years: 1 }).toISODate()! }],
      availability: fullAvailability,
      timezone: appConfig.DEFAULT_TIMEZONE,
      address: null,
      notes: "Fictional demo worker",
      voiceConsent: true,
      voiceConsentAt: now,
      voiceConsentSource: "fictional demo seed",
      smsConsent: true,
      smsConsentAt: now,
      smsConsentSource: "fictional demo seed",
      doNotCall: false,
      doNotText: false,
      lastContactedAt: null,
    };
    await db.insertInto("workers").values(worker).onConflict((oc) => options.refreshExisting
      ? oc.column("id").doUpdateSet({
          firstName: worker.firstName,
          lastName: worker.lastName,
          phone: worker.phone,
          email: worker.email,
          status: worker.status,
          roles: worker.roles,
          skills: worker.skills,
          certifications: worker.certifications,
          availability: worker.availability,
          timezone: worker.timezone,
          address: worker.address,
          notes: worker.notes,
          voiceConsent: worker.voiceConsent,
          voiceConsentAt: worker.voiceConsentAt,
          voiceConsentSource: worker.voiceConsentSource,
          smsConsent: worker.smsConsent,
          smsConsentAt: worker.smsConsentAt,
          smsConsentSource: worker.smsConsentSource,
          doNotCall: worker.doNotCall,
          doNotText: worker.doNotText,
          lastContactedAt: worker.lastContactedAt,
        })
      : oc.column("id").doNothing()).execute();
  }

  const startsAt = DateTime.now().setZone(appConfig.DEFAULT_TIMEZONE).plus({ days: 2 }).startOf("day").set({ hour: 17 }).toUTC().toJSDate();
  const shift = {
    id: "shf_banquet_demo",
    organizationId,
    clientId: client.id,
    locationId: location.id,
    role: "Banquet Server",
    requiredSkills: ["food-safety"],
    startsAt,
    endsAt: DateTime.fromJSDate(startsAt).plus({ hours: 6 }).toJSDate(),
    headcount: 3,
    payRateCents: 2400,
    status: "open" as const,
    notes: "Black shirt, black pants, and non-slip shoes required.",
    autoFillEnabled: false,
    autoFillStartedAt: null,
  };
  await db.insertInto("shifts").values(shift).onConflict((oc) => options.refreshExisting
    ? oc.column("id").doUpdateSet({
        clientId: shift.clientId,
        locationId: shift.locationId,
        role: shift.role,
        requiredSkills: shift.requiredSkills,
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
        headcount: shift.headcount,
        payRateCents: shift.payRateCents,
        status: shift.status,
        notes: shift.notes,
        autoFillEnabled: shift.autoFillEnabled,
        autoFillStartedAt: shift.autoFillStartedAt,
      })
    : oc.column("id").doNothing()).execute();
}

export async function seedDatabase(): Promise<void> {
  const db = createDatabase(config);
  try {
    await migrateToLatest(db);
    await ensureBootstrapAdmin(db, config);
    await seedDemoRecords(db, config);
  } finally {
    await db.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await seedDatabase();
  console.log(`Seed complete. Sign in with ${config.ADMIN_EMAIL}.`);
}
