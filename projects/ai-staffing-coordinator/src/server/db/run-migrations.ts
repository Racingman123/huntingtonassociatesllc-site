import { config } from "../config.js";
import { createDatabase } from "./database.js";
import { migrateToLatest } from "./migrator.js";

const db = createDatabase(config);
try {
  await migrateToLatest(db);
  console.log("Database migrations are up to date.");
} finally {
  await db.destroy();
}
