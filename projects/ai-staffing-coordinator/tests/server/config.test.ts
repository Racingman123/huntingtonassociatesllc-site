import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";

describe("public demo configuration", () => {
  it("accepts a passwordless public demo only with mock communications", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      PUBLIC_DEMO_MODE: "true",
      COMMUNICATION_PROVIDER: "mock",
    });

    expect(config.PUBLIC_DEMO_MODE).toBe(true);
    expect(config.COMMUNICATION_PROVIDER).toBe("mock");
  });

  it("rejects Twilio in a production public demo even when live credentials are complete", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      JWT_SECRET: "a-production-secret-that-is-over-32-characters-long",
      ADMIN_PASSWORD: "UniqueProductionPassword1!",
      PUBLIC_BASE_URL: "https://staffing.example.com",
      PUBLIC_DEMO_MODE: "true",
      COMMUNICATION_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: "AC_test",
      TWILIO_AUTH_TOKEN: "test-token",
      TWILIO_PHONE_NUMBER: "+12035550100",
      TWILIO_VALIDATE_WEBHOOKS: "true",
      OPENAI_API_KEY: "test-openai-key",
    })).toThrow(/PUBLIC_DEMO_MODE requires COMMUNICATION_PROVIDER=mock/);
  });

  it("keeps normal authenticated Twilio mode available when public demo mode is off", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      PUBLIC_DEMO_MODE: "false",
      COMMUNICATION_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: "AC_test",
      TWILIO_AUTH_TOKEN: "test-token",
      TWILIO_PHONE_NUMBER: "+12035550100",
    });

    expect(config.PUBLIC_DEMO_MODE).toBe(false);
    expect(config.COMMUNICATION_PROVIDER).toBe("twilio");
  });
});
