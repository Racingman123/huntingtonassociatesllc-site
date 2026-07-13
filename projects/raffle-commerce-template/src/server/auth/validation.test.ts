import { describe, expect, test } from "vitest";
import { loginSchema, passwordSchema } from "./validation";

describe("bcrypt-safe password validation", () => {
  test("accepts strong inputs within 72 UTF-8 bytes", () => {
    expect(passwordSchema.safeParse("Cedar!Orbit9-Violet").success).toBe(true);
    expect(loginSchema.safeParse({
      email: "user@example.test",
      password: "Cedar!Orbit9-Violet",
    }).success).toBe(true);
  });

  test("rejects character-count-safe inputs that exceed bcrypt's byte boundary", () => {
    const overlong = `${"é".repeat(35)}A1!`;
    expect(overlong.length).toBeLessThan(72);
    expect(passwordSchema.safeParse(overlong).success).toBe(false);
    expect(loginSchema.safeParse({ email: "user@example.test", password: overlong }).success).toBe(false);
  });
});
