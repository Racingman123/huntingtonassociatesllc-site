import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AccountShell } from "@/components/account/account-shell";
import { requireUser } from "@/server/auth/dal";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AccountLayout({ children }: { children: ReactNode }) {
  const viewer = await requireUser();
  return (
    <AccountShell
      brandName={viewer.tenant.displayName}
      user={{ name: viewer.name, role: viewer.role }}
    >
      {children}
    </AccountShell>
  );
}
