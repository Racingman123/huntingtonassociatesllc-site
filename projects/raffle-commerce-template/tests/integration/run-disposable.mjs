import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createDisposableDatabase, executable } from "../support/disposable-environment.mjs";

const root = resolve(import.meta.dirname, "../..");

function findTests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findTests(path);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

const cliArgs = process.argv.slice(2);
const requestedFiles = cliArgs.filter((argument) => argument.endsWith(".test.ts"));
const forwardedArgs = cliArgs.filter((argument) => !argument.endsWith(".test.ts"));
const allTestFiles = findTests(import.meta.dirname).sort();
const testFiles = requestedFiles.length
  ? allTestFiles.filter((file) => requestedFiles.some((requested) => (
      relative(root, file) === requested
      || file.endsWith(`/${requested}`)
    )))
  : allTestFiles;
if (!testFiles.length) throw new Error(`No integration test matched: ${requestedFiles.join(", ")}`);
let status = 0;
for (const [index, file] of testFiles.entries()) {
  const environment = createDisposableDatabase(`giveaway-integration-${index + 1}`);
  try {
    const result = environment.run(
      executable("vitest"),
      [
        "run",
        "--config",
        "vitest.integration.config.ts",
        relative(root, file),
        ...forwardedArgs,
      ],
    );
    if (result !== 0) status = result;
  } finally {
    environment.cleanup();
  }
}
process.exitCode = status;
