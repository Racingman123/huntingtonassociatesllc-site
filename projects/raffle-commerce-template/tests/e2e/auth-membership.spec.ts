import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.describe("authentication, authorization, and membership", () => {
  test("protected account routes preserve the intended destination through login", async ({ page }) => {
    await page.goto("/account/entries");
    await expect(page).toHaveURL(/\/login\?next=%2Faccount%2Fentries$/);
    await signIn(page, "customer");

    await expect(page).toHaveURL(/\/account\/entries$/);
    await expect(page.getByRole("heading", { level: 1, name: "Entry ledger" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  test("customer sessions cannot cross the staff RBAC boundary", async ({ page }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login\?next=%2Fadmin$/);
    await signIn(page, "customer");

    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole("heading", { level: 1, name: "Hi, Alex." })).toBeVisible();
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByText("Promotion operations", { exact: true })).toHaveCount(0);
  });

  test("staff credentials reach the operations console", async ({ page }) => {
    await page.goto("/admin");
    await signIn(page, "admin");

    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { level: 1, name: "Control room" })).toBeVisible();
    const navigationName = (page.viewportSize()?.width ?? 1_000) < 700
      ? "Mobile operations navigation"
      : "Operations console";
    await expect(page.getByRole("navigation", { name: navigationName })).toBeVisible();
  });

  test("registration requires email proof without implicitly signing in or entering", async ({ page }, testInfo) => {
    const email = `register-${testInfo.project.name}@example.test`;
    await page.goto("/register");
    const main = page.locator("main");
    await main.getByLabel("Full name").fill("E2E New Customer");
    await main.getByLabel("Email address").fill(email);
    await main.getByLabel("Password").fill("E2EPassword!234");
    await main.getByLabel("Confirm").fill("E2EPassword!234");
    await main.getByLabel(/I agree to the Website Terms/i).check();
    await main.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL(/\/verify-email\/request\?sent=1$/);
    await expect(page.getByText(/If an eligible account matches that address/i)).toBeVisible();
    await page.goto("/account");
    await expect(page).toHaveURL(/\/login\?next=%2Faccount$/);
    await page.locator("main").getByLabel("Email address").fill(email);
    await page.locator("main").getByLabel("Password").fill("E2EPassword!234");
    await page.locator("main").getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/verify-email\/request\?needed=1$/);
    await expect(page.getByText(/Email verification is required before sign-in/i)).toBeVisible();
  });

  test("membership initial capture appears once and cancellation schedules period end", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "The seeded account is mutated once in the serial desktop project.");
    await page.goto("/login?next=/membership");
    await signIn(page, "customer");
    await expect(page).toHaveURL(/\/membership$/);

    const start = page.getByRole("button", { name: "Start monthly membership" });
    if (await start.isVisible()) {
      await start.click();
      await expect(page).toHaveURL(/\/account\/membership\?started=1$/);
      await expect(page.getByText(/Membership started/i)).toBeVisible();
    } else {
      await page.getByRole("link", { name: "Manage membership" }).click();
      await expect(page).toHaveURL(/\/account\/membership$/);
    }

    await expect(page.getByRole("heading", { level: 2, name: "Basecamp Monthly" })).toBeVisible();
    await expect(page.getByText("1", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("+6,250", { exact: true })).toBeVisible();
    const cancel = page.getByRole("button", { name: "Cancel at period end" });
    if (await cancel.isVisible()) {
      await cancel.click();
      await expect(page).toHaveURL(/\/account\/membership\?cancelled=1$/);
    }
    await expect(page.getByText("Ends this period", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel at period end" })).toHaveCount(0);
  });
});
