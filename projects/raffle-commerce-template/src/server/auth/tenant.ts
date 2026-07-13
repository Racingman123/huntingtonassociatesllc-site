import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { db } from "@/server/db";
import { DEFAULT_TENANT_SLUG } from "./config";
import { isTwoDecimalCurrency } from "@/lib/format";

function hostnameFromHeader(value: string | null) {
  if (!value) return null;
  const first = value.split(",")[0]?.trim().toLowerCase();
  if (!first) return null;
  if (first.startsWith("[")) return first.slice(1, first.indexOf("]"));
  return first.split(":")[0] ?? null;
}

function configuredAppHostname() {
  try {
    return process.env.APP_URL ? new URL(process.env.APP_URL).hostname.toLowerCase() : null;
  } catch {
    throw new Error("APP_URL must be a valid absolute URL");
  }
}

function assertTenantRuntimeConfiguration<T extends {
  currency: string;
  flatShippingCents: number;
  freeShippingThresholdCents: number;
}>(tenant: T) {
  if (!isTwoDecimalCurrency(tenant.currency)) {
    throw new Error("Tenant currency must use exactly two minor-unit digits");
  }
  if (
    !Number.isSafeInteger(tenant.flatShippingCents)
    || tenant.flatShippingCents < 0
    || !Number.isSafeInteger(tenant.freeShippingThresholdCents)
    || tenant.freeShippingThresholdCents < 0
  ) {
    throw new Error("Tenant shipping configuration is invalid");
  }
  return tenant;
}

/** Resolve the tenant on the server; never accept a tenant id from form data. */
export const getRequestTenant = cache(async () => {
  const requestHeaders = await headers();
  const trustProxyHeaders = process.env.TRUST_PROXY_HEADERS === "true";
  const hostname = hostnameFromHeader(
    trustProxyHeaders
      ? requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host")
      : requestHeaders.get("host"),
  );

  const domainTenant = hostname
    ? await db.tenant.findFirst({
        where: { primaryDomain: hostname, status: "ACTIVE" },
        select: {
          id: true,
          slug: true,
          status: true,
          displayName: true,
          legalName: true,
          supportEmail: true,
          primaryDomain: true,
          currency: true,
          timezone: true,
          flatShippingCents: true,
          freeShippingThresholdCents: true,
        },
      })
    : null;

  if (domainTenant) return assertTenantRuntimeConfiguration(domainTenant);

  const localHost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const configuredHost = configuredAppHostname();
  if (
    process.env.NODE_ENV === "production"
    && hostname
    && !localHost
    && hostname !== configuredHost
  ) {
    throw new Error("Request host is not mapped to an active tenant");
  }

  const fallback = await db.tenant.findFirst({
    where: { slug: DEFAULT_TENANT_SLUG, status: "ACTIVE" },
    select: {
      id: true,
      slug: true,
      status: true,
      displayName: true,
      legalName: true,
      supportEmail: true,
      primaryDomain: true,
      currency: true,
      timezone: true,
      flatShippingCents: true,
      freeShippingThresholdCents: true,
    },
  });

  if (!fallback) throw new Error(`Active tenant '${DEFAULT_TENANT_SLUG}' was not found`);
  return assertTenantRuntimeConfiguration(fallback);
});
