import { titleCase } from "@/lib/format";
import styles from "./admin.module.css";

function tone(value: string) {
  const status = value.toUpperCase();
  if (["PASS", "READY", "ACTIVE", "LIVE", "APPROVED", "APPLIED", "RESOLVED", "CAPTURED", "PAID", "CONFIRMED", "FULFILLED", "POSTED", "GRANT", "SEALED", "VERIFIED", "PUBLISHED", "CLOSED"].includes(status)) return "good";
  if (["WARN", "WARNING", "PENDING", "REVIEW", "UNPAID", "UNFULFILLED", "RECONCILIATION", "SCHEDULED", "DRAFT", "DEMO"].includes(status)) return "warn";
  if (["FAIL", "ACTION_REQUIRED", "FAILED", "REJECTED", "CANCELLED", "REFUNDED", "REVERSED", "INVALID"].includes(status)) return "bad";
  if (["DRAW_READY", "DRAW_COMPLETE", "SELECTED", "PROVISIONAL"].includes(status)) return "info";
  return "neutral";
}

export function AdminBadge({ value }: { value: string }) {
  return <span className={styles.badge} data-tone={tone(value)}>{titleCase(value)}</span>;
}
