import { FileMigrationProvider, Migrator } from "kysely/migration";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import type { Database } from "./types.js";

export function createMigrator(db: Kysely<Database>): Migrator {
  const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
  return new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: directory }),
  });
}

export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const { error, results } = await createMigrator(db).migrateToLatest();
  for (const result of results ?? []) {
    if (result.status === "Error") throw new Error(`Migration ${result.migrationName} failed`, { cause: error });
  }
  if (error) throw error;
}
