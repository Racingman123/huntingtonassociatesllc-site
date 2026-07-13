import { buildApp } from "./app.js";
import { config } from "./config.js";
import { ensureBootstrapAdmin } from "./db/bootstrap.js";
import { createDatabase } from "./db/database.js";
import { migrateToLatest } from "./db/migrator.js";
import { seedDemoRecords } from "./db/seed.js";
import { startReminderWorker } from "./services/reminder-worker.js";

const db = createDatabase(config);

try {
  await migrateToLatest(db);
  await ensureBootstrapAdmin(db, config);
  if (config.PUBLIC_DEMO_MODE) await seedDemoRecords(db, config, { refreshExisting: true });
  const app = await buildApp({ config, db });
  const stopWorker = startReminderWorker(app);

  app.addHook("onClose", async () => {
    await stopWorker();
    await db.destroy();
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "Shutting down");
    await app.close();
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  console.error(error);
  await db.destroy();
  process.exitCode = 1;
}
