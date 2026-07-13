import {
  createDisposableDatabase,
  ephemeralNextDirectory,
  executable,
  removeProjectDirectory,
  reservePort,
} from "../support/disposable-environment.mjs";

const environment = createDisposableDatabase("giveaway-e2e");
const nextDirectory = ephemeralNextDirectory(environment.directory);
let status = 1;
try {
  // `node --import tsx` avoids the tsx CLI's local IPC socket, which is not
  // available in some sandboxed CI and agent environments.
  const seedStatus = environment.run(process.execPath, ["--import", "tsx", "prisma/seed.ts"]);
  if (seedStatus !== 0) throw new Error(`Unable to seed E2E database (seed exited ${seedStatus})`);

  const port = await reservePort();
  const baseURL = `http://127.0.0.1:${port}`;
  status = environment.run(
    executable("playwright"),
    ["test", ...process.argv.slice(2)],
    {
      E2E_DISPOSABLE_DB: "true",
      NEXT_DIST_DIR: nextDirectory,
      NODE_ENV: "development",
      PLAYWRIGHT_BASE_URL: baseURL,
      PLAYWRIGHT_PORT: String(port),
      APP_URL: baseURL,
    },
  );
} finally {
  removeProjectDirectory(nextDirectory);
  environment.cleanup();
}
process.exitCode = status;
