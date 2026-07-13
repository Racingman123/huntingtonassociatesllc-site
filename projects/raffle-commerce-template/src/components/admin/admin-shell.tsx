import Link from "next/link";
import type { ReactNode } from "react";
import { logoutAction } from "@/server/auth/actions";
import styles from "./admin.module.css";

const primaryLinks = [
  { label: "Control room", href: "/admin", roles: ["ADMIN", "STAFF", "OPERATIONS", "COMPLIANCE", "SUPPORT"] },
  { label: "Orders", href: "/admin/orders", roles: ["ADMIN", "OPERATIONS", "SUPPORT"] },
  { label: "Entry ledger", href: "/admin/entries", roles: ["ADMIN", "OPERATIONS", "COMPLIANCE"] },
  { label: "AMOE queue", href: "/admin/amoe", roles: ["ADMIN", "OPERATIONS", "COMPLIANCE"] },
  { label: "Draws & winners", href: "/admin/draws", roles: ["ADMIN", "OPERATIONS", "COMPLIANCE"] },
] as const;

const systemLinks = [
  { label: "Theme & catalog", href: "/admin/configuration", roles: ["ADMIN", "OPERATIONS"] },
  { label: "Audit & support", href: "/admin/audit", roles: ["ADMIN", "OPERATIONS", "COMPLIANCE", "SUPPORT"] },
] as const;

export function AdminShell({
  identity,
  children,
}: {
  identity: {
    name: string;
    email: string;
    role: string;
    tenant: { displayName: string };
  };
  children: ReactNode;
}) {
  const role = identity.role.toUpperCase();
  const visiblePrimaryLinks = primaryLinks.filter((link) => link.roles.some((candidate) => candidate === role));
  const visibleSystemLinks = systemLinks.filter((link) => link.roles.some((candidate) => candidate === role));
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link className={styles.brand} href="/admin">
          <span className={styles.brandName}>{identity.tenant.displayName}</span>
          <span>Promotion operations</span>
        </Link>
        <nav className={styles.nav} aria-label="Operations console">
          <div className={styles.navLabel}>Operations</div>
          {visiblePrimaryLinks.map(({ label, href }) => (
            <Link className={styles.navLink} href={href} key={href}><span>{label}</span><span>›</span></Link>
          ))}
          <div className={styles.navLabel}>System</div>
          {visibleSystemLinks.map(({ label, href }) => (
            <Link className={styles.navLink} href={href} key={href}><span>{label}</span><span>›</span></Link>
          ))}
        </nav>
        <div className={styles.sidebarFooter}>
          <div className={styles.operator}>
            <strong>{identity.name}</strong>
            <span>{identity.role} · {identity.email}</span>
          </div>
          <div className={styles.sidebarActions}>
            <Link className={styles.sidebarButton} href="/">Storefront</Link>
            <form action={logoutAction}>
              <button className={styles.sidebarButton} type="submit">Sign out</button>
            </form>
          </div>
        </div>
      </aside>
      <div className={styles.main}>
        <div className={styles.mobileBar}>
          <strong>Operations</strong>
          <nav className={styles.mobileNav} aria-label="Mobile operations navigation">
            <Link href="/admin">Home</Link>
            {visiblePrimaryLinks.filter((link) => link.href !== "/admin").map((link) => (
              <Link href={link.href} key={link.href}>{link.label}</Link>
            ))}
          </nav>
        </div>
        <main className={styles.content}>{children}</main>
      </div>
    </div>
  );
}
