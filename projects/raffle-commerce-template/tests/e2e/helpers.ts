import { expect, type Page } from "@playwright/test";

export const demoUsers = {
  customer: { email: "alex@example.com", password: "DemoCustomer!234" },
  admin: { email: "admin@example.com", password: "DemoAdmin!234" },
} as const;

export async function signIn(page: Page, kind: keyof typeof demoUsers) {
  const user = demoUsers[kind];
  const main = page.locator("main");
  await main.getByLabel("Email address").fill(user.email);
  await main.getByLabel("Password").fill(user.password);
  await main.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/);
}
