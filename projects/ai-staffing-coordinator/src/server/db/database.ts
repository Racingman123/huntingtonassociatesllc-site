import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { AppConfig } from "../config.js";
import type { Database } from "./types.js";

export function createDatabase(config: AppConfig): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.NODE_ENV === "test" ? 4 : 12,
    ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    application_name: "staffing-voice-agent",
  });
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}
