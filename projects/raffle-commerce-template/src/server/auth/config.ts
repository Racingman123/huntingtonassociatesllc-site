import "server-only";

export const SESSION_COOKIE_NAME = "giveaway_session";
export const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 30;
export const DEFAULT_TENANT_SLUG = process.env.DEFAULT_TENANT_SLUG ?? "northstar";

export const STAFF_ROLES = new Set([
  "ADMIN",
  "STAFF",
  "OPERATIONS",
  "COMPLIANCE",
  "SUPPORT",
]);

export function isStaffRole(role: string) {
  return STAFF_ROLES.has(role.toUpperCase());
}

