import type { Metadata } from "next";
import { OverviewConsole } from "@/components/admin/overview-console";
import { getAdminOverview } from "@/server/admin/dal";

export const metadata: Metadata = { title: "Promotion operations" };

export default async function AdminPage() {
  const data = await getAdminOverview();
  return <OverviewConsole data={data} />;
}

