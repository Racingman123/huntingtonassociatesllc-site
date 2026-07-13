import { afterEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../../src/server/db/types.js";
import { createTestDatabase } from "../helpers/database.js";

describe("database migrations", () => {
  let db: Kysely<Database> | undefined;

  afterEach(async () => {
    await db?.destroy();
  });

  it("creates the complete schema on PostgreSQL", async () => {
    db = await createTestDatabase();
    const result = await db
      .selectFrom("organizations")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();

    expect(Number(result.count)).toBe(0);
  });
});
