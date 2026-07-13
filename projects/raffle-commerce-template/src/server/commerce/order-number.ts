import { randomBytes } from "node:crypto";

/** Brand-neutral public identifier; database uniqueness remains tenant-scoped. */
export function createOrderNumber() {
  return `ORD-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`;
}
