import "server-only";

function configured(value: string | undefined, minimum = 1) {
  return Boolean(value?.trim() && value.trim().length >= minimum && !/replace-with|example/i.test(value));
}

function validAppUrl(value: string | undefined, production: boolean) {
  try {
    if (!value) return false;
    const url = new URL(value);
    return production ? url.protocol === "https:" : ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function deploymentEnvironment() {
  const configuredEnvironment = process.env.DEPLOYMENT_ENV?.trim().toLowerCase();
  if (["development", "staging", "production"].includes(configuredEnvironment ?? "")) {
    return configuredEnvironment as "development" | "staging" | "production";
  }
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

export function getDeploymentReadiness() {
  const deployedRuntime = process.env.NODE_ENV === "production";
  const environment = deploymentEnvironment();
  const production = environment === "production";
  const demoMode = process.env.DEMO_MODE === "true";
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  const postgres = /^(postgres|postgresql):\/\//i.test(databaseUrl);
  const sessionReady = configured(process.env.SESSION_SECRET, 32);
  const cronReady = configured(process.env.CRON_SECRET, 32)
    && process.env.CRON_SECRET !== process.env.SESSION_SECRET;
  const stripeReady = configured(process.env.STRIPE_SECRET_KEY)
    && configured(process.env.STRIPE_WEBHOOK_SECRET)
    && configured(process.env.STRIPE_WEBHOOK_API_VERSION)
    && process.env.STRIPE_WEBHOOK_LIVEMODE === (production ? "true" : "false");
  const emailReady = configured(process.env.RESEND_API_KEY)
    && configured(process.env.EMAIL_FROM)
    && !/@example\./i.test(process.env.EMAIL_FROM ?? "");

  const checks = [
    {
      key: "database",
      label: "Database",
      status: configured(databaseUrl) && (!deployedRuntime || postgres) ? "READY" : "ACTION_REQUIRED",
      detail: !configured(databaseUrl)
        ? "Set DATABASE_URL."
        : deployedRuntime && !postgres
          ? "A deployed Next.js runtime requires reviewed PostgreSQL; SQLite is local-only."
          : "Database connection configuration is present.",
      required: true,
    },
    {
      key: "sessions",
      label: "Session security",
      status: sessionReady ? "READY" : "ACTION_REQUIRED",
      detail: sessionReady
        ? "A non-placeholder session HMAC secret is configured."
        : "Set a non-placeholder SESSION_SECRET with at least 32 characters.",
      required: true,
    },
    {
      key: "origin",
      label: "Canonical application URL",
      status: validAppUrl(process.env.APP_URL, deployedRuntime) ? "READY" : "ACTION_REQUIRED",
      detail: validAppUrl(process.env.APP_URL, deployedRuntime)
        ? "Canonical application origin is configured."
        : deployedRuntime ? "A deployed APP_URL must be an absolute HTTPS origin." : "Set APP_URL to an absolute origin.",
      required: true,
    },
    {
      key: "demo",
      label: "Demo mutation boundary",
      status: deployedRuntime ? (demoMode ? "ACTION_REQUIRED" : "READY") : (demoMode ? "DEMO" : "READY"),
      detail: demoMode
        ? "Synthetic capture and automatic demo operations are enabled."
        : "Demo-only routes are disabled.",
      required: deployedRuntime,
    },
    {
      key: "payments",
      label: "Stripe webhook settlement",
      status: stripeReady ? "READY" : demoMode && !production ? "DEMO" : "ACTION_REQUIRED",
      detail: stripeReady
        ? "Stripe keys, pinned API version, signed webhook secret, and live-event mode are configured."
        : demoMode && !production ? "Demo checkout is active; no live payment is captured." : "Configure the complete live Stripe webhook environment.",
      required: deployedRuntime,
    },
    {
      key: "maintenance",
      label: "Maintenance authentication",
      status: cronReady ? "READY" : demoMode && !production ? "DEMO" : "ACTION_REQUIRED",
      detail: cronReady
        ? "An independent maintenance bearer secret is configured."
        : "Set CRON_SECRET to a non-placeholder value distinct from SESSION_SECRET.",
      required: deployedRuntime,
    },
    {
      key: "email",
      label: "Transactional email",
      status: emailReady ? "READY" : demoMode && !production ? "DEMO" : "ACTION_REQUIRED",
      detail: emailReady
        ? "A non-example sender and email provider key are configured."
        : demoMode && !production ? "Email delivery is intentionally disabled in demo mode." : "Configure a verified sender and notification provider.",
      required: deployedRuntime,
    },
    {
      key: "tax-fulfillment",
      label: "Tax and fulfillment adapters",
      status: production ? "ACTION_REQUIRED" : "DEMO",
      detail: production
        ? "The template does not ship a tax engine or fulfillment consumer. Replace this gate with live adapter health checks before launch."
        : "The local demo records zero tax and fulfillment intent only.",
      required: production,
    },
    {
      key: "staff-draw-assurance",
      label: "Staff MFA and independent draw custody",
      status: production ? "ACTION_REQUIRED" : "DEMO",
      detail: production
        ? "Add enforced staff MFA/SSO and an approved independent draw/import custody flow, then replace this gate with verifiable checks."
        : "Password-only staff access and the internal draw are demonstration controls.",
      required: production,
    },
  ] as const;

  return {
    demoMode,
    environment,
    production,
    checks,
    ready: checks.every((item) => !item.required || item.status === "READY"),
  };
}
