import { describe, expect, it } from "vitest";
import { assertStripeHostedUrl } from "./hosted-url";

describe("Stripe hosted redirect allowlist", () => {
  it("accepts only exact HTTPS Stripe hosts", () => {
    expect(assertStripeHostedUrl("https://checkout.stripe.com/c/pay/test", ["checkout.stripe.com"]))
      .toBe("https://checkout.stripe.com/c/pay/test");
    for (const value of [
      "http://checkout.stripe.com/c/pay/test",
      "https://checkout.stripe.com.evil.test/c/pay/test",
      "https://evil.test/?next=https://checkout.stripe.com",
      "javascript:alert(1)",
    ]) {
      expect(() => assertStripeHostedUrl(value, ["checkout.stripe.com"])).toThrow(/hosted redirect|unexpected/i);
    }
  });
});
