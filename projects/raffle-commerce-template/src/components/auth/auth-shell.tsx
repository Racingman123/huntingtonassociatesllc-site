import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./auth.module.css";

export function AuthShell({
  brandName,
  eyebrow,
  storyTitle,
  storyDescription,
  children,
}: {
  brandName: string;
  eyebrow: string;
  storyTitle: string;
  storyDescription: string;
  children: ReactNode;
}) {
  const initial = brandName.trim().charAt(0).toUpperCase() || "G";
  return (
    <main className={styles.page}>
      <section className={styles.storyPanel} aria-label={`${brandName} account access`}>
        <Link className={styles.brandLink} href="/">
          <span className={styles.brandMark} aria-hidden="true">{initial}</span>
          {brandName}
        </Link>
        <div className={styles.storyContent}>
          <p className={styles.eyebrow}>{eyebrow}</p>
          <h1 className={styles.storyTitle}>{storyTitle}</h1>
          <p className={styles.storyDescription}>{storyDescription}</p>
          <div className={styles.assuranceRow} aria-label="Account assurances">
            <span>Order history</span>
            <span>Verifiable entry ledger</span>
            <span>Secure sessions</span>
          </div>
        </div>
        <p className={styles.legalNote}>
          No purchase necessary. A purchase will not increase chances of winning.
          See the official rules for eligibility, entry methods, dates, prize details, and odds.
        </p>
      </section>
      <section className={styles.formPanel}>
        <div className={styles.formWrap}>
          <Link className={`${styles.brandLink} ${styles.mobileBrand}`} href="/">
            <span className={styles.brandMark} aria-hidden="true">{initial}</span>
            {brandName}
          </Link>
          {children}
        </div>
      </section>
    </main>
  );
}

