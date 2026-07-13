import { describe, expect, it } from "vitest";
import { jsonValue } from "../../src/server/db/json.js";

describe("jsonValue", () => {
  it("serializes top-level arrays for PostgreSQL JSONB parameters", () => {
    expect(jsonValue(["Banquet Server", "Server"])).toBe('["Banquet Server","Server"]');
  });

  it("serializes nested demo objects without changing their JSON shape", () => {
    expect(JSON.parse(jsonValue({ monday: [{ start: "08:00", end: "17:00" }] }))).toEqual({
      monday: [{ start: "08:00", end: "17:00" }],
    });
  });
});
