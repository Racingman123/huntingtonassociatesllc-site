import { titleCase } from "@/lib/format";
import styles from "./account.module.css";

function tone(value: string) {
  const normalized = value.toUpperCase();
  if (["ACTIVE", "APPROVED", "CAPTURED", "PAID", "CONFIRMED", "FULFILLED", "POSTED", "GRANT", "VERIFIED"].includes(normalized)) return "good";
  if (["PENDING", "UNPAID", "UNFULFILLED", "PROCESSING", "REVIEW"].includes(normalized)) return "warn";
  if (["FAILED", "REJECTED", "CANCELLED", "REFUNDED", "REVERSED", "REVOKED"].includes(normalized)) return "bad";
  return "neutral";
}

export function StatusPill({ value }: { value: string }) {
  return <span className={styles.status} data-tone={tone(value)}>{titleCase(value)}</span>;
}

