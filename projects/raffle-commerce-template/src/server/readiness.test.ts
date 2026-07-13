import { afterEach, describe, expect, it, vi } from "vitest";
import { getDeploymentReadiness } from "./readiness";

function configureDeployedProfile(environment: "staging" | "production", livemode: "false" | "true") {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DEPLOYMENT_ENV", environment);
  vi.stubEnv("DATABASE_URL", "postgresql://runtime:secret@db.internal:5432/giveaway");
  vi.stubEnv("SESSION_SECRET", "session-secret-that-is-longer-than-thirty-two-characters");
  vi.stubEnv("CRON_SECRET", "cron-secret-that-is-different-and-longer-than-thirty-two");
  vi.stubEnv("APP_URL", `https://${environment}.brand.test`);
  vi.stubEnv("DEMO_MODE", "false");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_configured_value");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_configured_value");
  vi.stubEnv("STRIPE_WEBHOOK_API_VERSION", "2026-06-24.dahlia");
  vi.stubEnv("STRIPE_WEBHOOK_LIVEMODE", livemode);
  vi.stubEnv("EMAIL_FROM", "Brand Operations <notices@brand.test>");
  vi.stubEnv("RESEND_API_KEY", "re_configured_value");
}

afterEach(() => vi.unstubAllEnvs());

describe("deployment readiness profiles", () => {
  it("accepts Stripe test-mode events for an otherwise production-shaped staging runtime", () => {
    configureDeployedProfile("staging", "false");
    const readiness = getDeploymentReadiness();
    expect(readiness).toMatchObject({ environment: "staging", production: false, ready: true });
    expect(readiness.checks.find((check) => check.key === "payments")?.status).toBe("READY");
  });

  it("requires live Stripe mode and retains explicit external launch gates for production", () => {
    configureDeployedProfile("production", "false");
    const wrongMode = getDeploymentReadiness();
    expect(wrongMode.checks.find((check) => check.key === "payments")?.status).toBe("ACTION_REQUIRED");

    vi.stubEnv("STRIPE_WEBHOOK_LIVEMODE", "true");
    const liveMode = getDeploymentReadiness();
    expect(liveMode).toMatchObject({ environment: "production", production: true, ready: false });
    expect(liveMode.checks.find((check) => check.key === "payments")?.status).toBe("READY");
    expect(liveMode.checks.find((check) => check.key === "tax-fulfillment")?.status).toBe("ACTION_REQUIRED");
    expect(liveMode.checks.find((check) => check.key === "staff-draw-assurance")?.status).toBe("ACTION_REQUIRED");
  });
});
