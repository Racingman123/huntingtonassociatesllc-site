import { sql } from "kysely";
import { config } from "../config.js";
import { createDatabase } from "./database.js";
import { migrateToLatest } from "./migrator.js";

if (config.NODE_ENV === "production") {
  throw new Error("Refusing to reset a production database");
}

const db = createDatabase(config);
try {
  await sql`drop schema if exists public cascade`.execute(db);
  await sql`create schema public`.execute(db);
  await migrateToLatest(db);
  console.log("Database schema reset and migrations applied. Run npm run db:seed to load demo data.");
} finally {
  await db.destroy();
}
