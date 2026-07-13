/**
 * PostgreSQL's `pg` driver encodes top-level JavaScript arrays as PostgreSQL
 * arrays. JSONB parameters must therefore be serialized explicitly so arrays
 * and objects behave the same in PostgreSQL and the embedded test database.
 */
export function jsonValue(value: unknown): string {
  return JSON.stringify(value);
}
