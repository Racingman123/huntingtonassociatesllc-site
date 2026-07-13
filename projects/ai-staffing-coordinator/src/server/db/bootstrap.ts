import bcrypt from "bcryptjs";
import type { Kysely } from "kysely";
import { nanoid } from "nanoid";
import type { AppConfig } from "../config.js";
import type { Database } from "./types.js";

export const BOOTSTRAP_ORGANIZATION_ID = "org_default";

/**
 * Creates the first tenant and administrator when absent. Existing credentials
 * are deliberately never replaced during application startup.
 */
export async function ensureBootstrapAdmin(db: Kysely<Database>, config: AppConfig): Promise<void> {
  const email = config.ADMIN_EMAIL.trim().toLowerCase();
  await db.insertInto("organizations").values({
    id: BOOTSTRAP_ORGANIZATION_ID,
    name: config.COMPANY_DISPLAY_NAME,
    timezone: config.DEFAULT_TIMEZONE,
  }).onConflict((oc) => oc.column("id").doUpdateSet({
    name: config.COMPANY_DISPLAY_NAME,
    timezone: config.DEFAULT_TIMEZONE,
  })).execute();

  const existing = await db.selectFrom("users")
    .select("id")
    .where("organizationId", "=", BOOTSTRAP_ORGANIZATION_ID)
    .where("email", "=", email)
    .executeTakeFirst();
  // Never reactivate, rename, or reset credentials for an existing account on restart.
  if (existing) return;

  await db.insertInto("users").values({
    id: nanoid(),
    organizationId: BOOTSTRAP_ORGANIZATION_ID,
    email,
    passwordHash: await bcrypt.hash(config.ADMIN_PASSWORD, 12),
    name: "Staffing Administrator",
    role: "admin",
    active: true,
  }).onConflict((oc) => oc.columns(["organizationId", "email"]).doNothing()).execute();
}
