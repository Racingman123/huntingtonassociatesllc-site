import "server-only";

const safeHostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function canonicalSiteUrl(tenant: { primaryDomain: string | null }) {
  if (
    process.env.NODE_ENV === "production"
    && tenant.primaryDomain
    && tenant.primaryDomain !== "localhost"
    && safeHostname.test(tenant.primaryDomain)
  ) {
    return `https://${tenant.primaryDomain.toLowerCase()}`;
  }

  const configured = process.env.APP_URL ?? "http://localhost:3000";
  const url = new URL(configured);
  return url.origin;
}
