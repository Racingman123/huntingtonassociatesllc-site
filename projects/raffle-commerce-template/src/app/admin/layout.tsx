import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { getAdminIdentity } from "@/server/admin/dal";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const identity = await getAdminIdentity();
  return <AdminShell identity={identity}>{children}</AdminShell>;
}
