import Link from "next/link";
import type { ReactNode } from "react";
import { logoutAction } from "@/server/auth/actions";
import { isStaffRole } from "@/server/auth/config";
import styles from "./account.module.css";

const accountLinks = [
  ["Overview", "/account"],
  ["Orders", "/account/orders"],
  ["Entry ledger", "/account/entries"],
  ["Membership", "/account/membership"],
  ["Profile & security", "/account/profile"],
] as const;

export function AccountShell({
  brandName,
  user,
  children,
}: {
  brandName: string;
  user: { name: string; role: string };
  children: ReactNode;
}) {
  const initial = brandName.trim().charAt(0).toUpperCase() || "G";
  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <Link className={styles.brand} href="/">
            <span className={styles.brandMark} aria-hidden="true">{initial}</span>
            {brandName}
          </Link>
          <div className={styles.topActions}>
            <div className={styles.identity}>
              <strong>{user.name}</strong>
              <span>{user.role}</span>
            </div>
            {isStaffRole(user.role) && (
              <Link className={styles.adminLink} href="/admin">Operations console</Link>
            )}
            <form action={logoutAction}>
              <button className={styles.smallButton} type="submit">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <nav className={styles.nav} aria-label="Account navigation">
        <div className={styles.navInner}>
          {accountLinks.map(([label, href]) => (
            <Link className={styles.navLink} href={href} key={href}>{label}</Link>
          ))}
        </div>
      </nav>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
