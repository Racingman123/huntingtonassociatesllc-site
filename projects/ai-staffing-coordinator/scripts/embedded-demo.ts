import { PGlite } from "@electric-sql/pglite";
import { CamelCasePlugin, Kysely, PGliteDialect } from "kysely";
import path from "node:path";
import { buildApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { ensureBootstrapAdmin } from "../src/server/db/bootstrap.js";
import { migrateToLatest } from "../src/server/db/migrator.js";
import { seedDemoRecords } from "../src/server/db/seed.js";
import type { Database } from "../src/server/db/types.js";

const port = Number(process.env.DEMO_PORT ?? 3100);
const config = loadConfig({
  NODE_ENV: "development",
  PORT: port,
  HOST: "127.0.0.1",
  PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
  DATABASE_URL: "postgresql://embedded-demo",
  PUBLIC_DEMO_MODE: "true",
  COMMUNICATION_PROVIDER: "mock",
  SCHEDULER_ENABLED: "false",
  CONTACT_WINDOW_START_LOCAL: 0,
  CONTACT_WINDOW_END_LOCAL: 24,
  ADMIN_EMAIL: process.env.ADMIN_EMAIL ?? "admin@example.com",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? "ChangeMe123!",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
});

const db = new Kysely<Database>({
  dialect: new PGliteDialect({ pglite: new PGlite() }),
  plugins: [new CamelCasePlugin()],
});
await migrateToLatest(db);
await ensureBootstrapAdmin(db, config);
await seedDemoRecords(db, config, { refreshExisting: true });

const app = await buildApp({ config, db, staticRoot: path.resolve("dist/client") });
app.addHook("onClose", async () => db.destroy());
await app.listen({ host: config.HOST, port: config.PORT });

console.log(`Embedded demo: http://127.0.0.1:${port}`);
console.log("Public demo mode: no sign-in required; all communications are simulated.");

const shutdown = () => void app.close();
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
