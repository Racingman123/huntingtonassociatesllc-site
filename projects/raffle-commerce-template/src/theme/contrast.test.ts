import { describe, expect, it } from "vitest";
import { defaultTheme } from "./default-theme";
import { contrastRatio, themeContrastIssues } from "./contrast";

describe("theme contrast", () => {
  it("accepts every required default-theme text pair", () => {
    expect(themeContrastIssues(defaultTheme)).toEqual([]);
  });

  it("reports an inaccessible primary button pair", () => {
    const theme = {
      ...defaultTheme,
      colors: {
        ...defaultTheme.colors,
        primary: "#ffffff",
        primaryForeground: "#fefefe",
      },
    };
    expect(themeContrastIssues(theme).some((issue) => issue.pair === "primary button")).toBe(true);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });
});
