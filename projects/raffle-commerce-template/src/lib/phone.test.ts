import { describe, expect, test } from "vitest";
import { normalizePhone, phoneSchema } from "./phone";

describe("phone normalization", () => {
  test.each([
    ["+1 (303) 555-0148", "+13035550148"],
    ["303.555.0148", "3035550148"],
    [" 020 7946 0958 ", "02079460958"],
    ["555-0123", "5550123"],
  ])("normalizes %s to a canonical contact number", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  test.each([
    "555-12",
    "+1 303 CALL-NOW",
    "++13035550148",
    "1/303/555/0148",
    "1".repeat(21),
  ])("rejects invalid value %s", (input) => {
    expect(phoneSchema.safeParse(input).success).toBe(false);
  });
});
