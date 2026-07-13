import { PGlite } from "@electric-sql/pglite";
import { CamelCasePlugin, Kysely, PGliteDialect } from "kysely";
import type { Database } from "../../src/server/db/types.js";
import { migrateToLatest } from "../../src/server/db/migrator.js";

export async function createTestDatabase(): Promise<Kysely<Database>> {
  const db = new Kysely<Database>({
    dialect: new PGliteDialect({ pglite: new PGlite() }),
    plugins: [new CamelCasePlugin()],
  });
  await migrateToLatest(db);
  return db;
}
