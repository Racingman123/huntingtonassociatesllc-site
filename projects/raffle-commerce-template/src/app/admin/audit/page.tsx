import type { Metadata } from "next";
import { AuditConsole } from "@/components/admin/audit-console";
import { getAdminAudit } from "@/server/admin/dal";

export const metadata: Metadata = { title: "Audit and support · Operations" };

export default async function AdminAuditPage() {
  const data = await getAdminAudit();
  return <AuditConsole data={data} />;
}

