import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const axePath = resolve(process.cwd(), "node_modules/axe-core/axe.min.js");

for (const [surface, path] of [
  ["home", "/"],
  ["shop", "/shop"],
  ["cart", "/cart"],
  ["policies", "/policies"],
] as const) {
  test(`${surface} has keyboard structure and no serious or critical axe violations`, async ({ page }) => {
    await page.goto(path);

    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();

    await page.addScriptTag({ path: axePath });
    const violations = await page.evaluate(async () => {
      const axe = (window as typeof window & {
        axe: {
          run: (
            context: Document,
            options: { runOnly: { type: "tag"; values: string[] } },
          ) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              help: string;
              nodes: Array<{ target: string[]; failureSummary?: string }>;
            }>;
          }>;
        };
      }).axe;
      const result = await axe.run(document, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
        },
      });
      return result.violations
        .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
        .map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          help: violation.help,
          targets: violation.nodes.map((node) => node.target.join(" ")),
        }));
    });

    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
}
