import { describe, expect, it } from "vitest";
import { defaultTheme } from "./default-theme";
import { parseThemeConfig, themeCssVariables } from "./schema";

describe("theme contract", () => {
  it("parses the default theme and emits an allowlisted variable map", () => {
    const parsed = parseThemeConfig(defaultTheme);
    const variables = themeCssVariables(parsed);
    expect(variables["--color-primary"]).toBe(defaultTheme.colors.primary);
    expect(Object.keys(variables).every((key) => key.startsWith("--"))).toBe(true);
  });

  it("rejects CSS injection and invalid color tokens", () => {
    expect(() => parseThemeConfig({
      ...defaultTheme,
      colors: { ...defaultTheme.colors, primary: "red; background:url(https://bad.example)" },
    })).toThrow();
  });

  it("allows only web protocols for administrator-supplied social links", () => {
    expect(() => parseThemeConfig({
      ...defaultTheme,
      social: { ...defaultTheme.social, instagram: "javascript:alert(1)" },
    })).toThrow();
    expect(() => parseThemeConfig({
      ...defaultTheme,
      social: { ...defaultTheme.social, instagram: "mailto:owner@example.com" },
    })).toThrow();
    expect(parseThemeConfig({
      ...defaultTheme,
      social: { ...defaultTheme.social, instagram: "https://instagram.com/example" },
    }).social.instagram).toBe("https://instagram.com/example");
  });

  it("allows local logo assets but rejects remote and traversal paths", () => {
    expect(parseThemeConfig({
      ...defaultTheme,
      brand: { ...defaultTheme.brand, logoImage: "/brand/logo.svg" },
    }).brand.logoImage).toBe("/brand/logo.svg");
    for (const logoImage of ["https://untrusted.example/logo.svg", "//untrusted.example/logo.svg", "/../secret"]) {
      expect(() => parseThemeConfig({
        ...defaultTheme,
        brand: { ...defaultTheme.brand, logoImage },
      })).toThrow();
    }
  });
});
