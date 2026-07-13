import { expect, test } from "@playwright/test";

test.describe("public storefront and entry paths", () => {
  test("home presents the active prize, live rate, disclosures, and responsive navigation", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveTitle(/Northstar Supply/);
    await expect(page.getByRole("heading", { level: 1, name: /Win the Adventure Rig \+ \$25,000/i })).toBeVisible();
    await expect(page.getByText(/250X ENTRIES THIS WEEK/i)).toBeVisible();
    await expect(page.getByText(/NO PURCHASE NECESSARY/i).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Use the free entry method/i })).toHaveAttribute(
      "href",
      "/giveaways/adventure-rig/free-entry",
    );

    if ((page.viewportSize()?.width ?? 1_000) < 700) {
      await page.getByLabel("Open navigation").click();
      await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("link", { name: "Enter without purchase" })).toBeVisible();
    } else {
      await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
    }
  });

  test("cart and checkout preserve the server-authoritative entry quote through confirmation", async ({ page }, testInfo) => {
    await page.goto("/products/fast-pass-bronze");
    await expect(page.getByRole("heading", { level: 1, name: "Fast Pass Bronze" })).toBeVisible();
    await expect(page.getByText("24,500 entries", { exact: true })).toBeVisible();
    await page.locator(".purchase-panel").getByRole("button", { name: "Add to cart" }).click();

    await page.goto("/cart");
    await expect(page.getByRole("heading", { level: 1, name: "Cart" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Fast Pass Bronze" })).toBeVisible();
    await expect(page.getByText("24,500", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Continue to checkout" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Contact and delivery" })).toBeVisible();
    const checkout = page.locator("main");
    await checkout.getByLabel("Email", { exact: true }).fill(`checkout-${testInfo.project.name}@example.test`);
    await checkout.getByLabel("Full name").fill("Checkout E2E Tester");
    await checkout.getByLabel("Phone").fill("+1 (303) 555-0148");
    await checkout.getByLabel("Street address").fill("100 Test Trail");
    await checkout.getByLabel("City").fill("Denver");
    await checkout.getByLabel("State").fill("CO");
    await checkout.getByLabel("Postal code").fill("80202");
    await checkout.getByLabel(/I confirm that I am at least 18/i).check();
    await checkout.getByLabel(/I have read and accept the Official Rules/i).check();
    await checkout.getByRole("button", { name: "Complete demo order" }).click();

    await expect(page).toHaveURL(/\/checkout\/success\?receipt=/);
    await expect(page.getByRole("heading", { level: 1, name: /You.re in/i })).toBeVisible();
    const posted = page.locator(".success-entry-total");
    await expect(posted.getByText("Entries posted", { exact: true })).toBeVisible();
    await expect(posted.getByText("24,500", { exact: true })).toBeVisible();
  });

  test("recurring membership is absent from the ordinary shop and product route", async ({ page }) => {
    await page.goto("/shop");
    await expect(page.getByRole("heading", { name: "Basecamp Membership" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Basecamp Membership/i })).toHaveCount(0);

    const response = await page.goto("/products/basecamp-membership");
    expect(response?.status()).toBe(404);
  });

  test("free entry requires no marketing consent and records a same-pool award", async ({ page }, testInfo) => {
    await page.goto("/giveaways/adventure-rig/free-entry");

    await expect(page.getByRole("heading", { level: 1, name: "Enter free." })).toBeVisible();
    await expect(page.getByText(/No order, payment, donation, app download, referral, survey, or marketing opt-in is required/i)).toBeVisible();
    await expect(page.getByText(/same drawing and have the same chance per entry/i)).toBeVisible();
    const entryForm = page.locator("main");
    await entryForm.getByLabel("Full legal name").fill("Free Entry E2E Tester");
    await entryForm.getByLabel("Phone").fill("+1 (303) 555-0148");
    await entryForm.getByLabel("Email", { exact: true }).fill(`free-${testInfo.project.name}@example.test`);
    await entryForm.getByLabel("State").fill("CO");
    await entryForm.getByLabel("Postal code").fill("80202");
    await entryForm.getByLabel(/I confirm I am at least 18/i).check();
    await entryForm.getByLabel(/I am a legal resident/i).check();
    await entryForm.getByLabel(/I have read and accept the Official Rules/i).check();
    await entryForm.getByRole("button", { name: /Submit free entry — 25,000 entries/i }).click();

    const success = page.locator(".free-entry-success");
    await expect(success.getByText("ENTRY RECORDED", { exact: true })).toBeVisible();
    await expect(success.getByRole("heading", { name: "No purchase. Same prize pool." })).toBeVisible();
    await expect(success.getByText("25,000", { exact: true })).toBeVisible();
    await expect(success.getByText(/FREE-[A-F0-9]{10}/)).toBeVisible();
  });
});
