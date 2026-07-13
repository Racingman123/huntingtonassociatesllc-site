import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(import.meta.dirname, "../..");

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function projectExecutable(name) {
  return resolve(projectRoot, "node_modules", ".bin", name);
}

export function createDisposableDatabase(label) {
  const directory = mkdtempSync(join(tmpdir(), `${label}-`));
  const databasePath = join(directory, "test.db");
  // Create the file eagerly so a typo can never make Prisma fall back to a
  // checked-in or developer-owned database.
  closeSync(openSync(databasePath, "wx"));
  const env = {
    ...process.env,
    DATABASE_URL: `file:${databasePath}`,
    DEMO_MODE: "true",
    SESSION_SECRET: "integration-only-session-secret-at-least-32-characters",
    APP_URL: "http://127.0.0.1",
    NODE_ENV: "test",
  };

  const pushStatus = run(projectExecutable("prisma"), ["db", "push", "--skip-generate"], env);
  if (pushStatus !== 0) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`Unable to create disposable database (Prisma exited ${pushStatus})`);
  }
  const hardenStatus = run(projectExecutable("prisma"), [
    "db",
    "execute",
    "--schema",
    "prisma/schema.prisma",
    "--file",
    "prisma/sql/sqlite-hardening.sql",
  ], env);
  if (hardenStatus !== 0) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`Unable to harden disposable database (Prisma exited ${hardenStatus})`);
  }

  return {
    directory,
    env,
    run(command, args, overrides = {}) {
      return run(command, args, { ...env, ...overrides });
    },
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function reservePort() {
  // Avoid a probe listener: some sandboxed runners disallow binding sockets in
  // the orchestration process even though the test web server is permitted.
  // The high, process-scoped choice keeps collisions vanishingly unlikely.
  return 31_000 + ((process.pid + Date.now()) % 20_000);
}

export function executable(name) {
  return projectExecutable(name);
}

export function ephemeralNextDirectory(databaseDirectory) {
  return `.next-e2e-${basename(databaseDirectory)}`;
}

export function removeProjectDirectory(relativePath) {
  const target = resolve(projectRoot, relativePath);
  if (!target.startsWith(`${projectRoot}/.next-e2e-`)) {
    throw new Error(`Refusing to remove non-E2E directory: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
}
