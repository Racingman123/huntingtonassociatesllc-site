import { describe, expect, it } from "vitest";
import { formatMoney, isTwoDecimalCurrency } from "./format";

describe("money formatting contract", () => {
  it("accepts currencies represented by the cents-based domain model", () => {
    expect(isTwoDecimalCurrency("USD")).toBe(true);
    expect(isTwoDecimalCurrency("CAD")).toBe(true);
    expect(formatMoney(12345, "CAD")).toContain("123.45");
  });

  it("rejects zero- and non-two-decimal currencies from tenant overlays", () => {
    expect(isTwoDecimalCurrency("JPY")).toBe(false);
    expect(isTwoDecimalCurrency("KWD")).toBe(false);
    expect(isTwoDecimalCurrency("ZZZ")).toBe(false);
    expect(isTwoDecimalCurrency("not-a-currency")).toBe(false);
  });
});
