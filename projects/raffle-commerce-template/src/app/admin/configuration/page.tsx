import type { Metadata } from "next";
import { ConfigurationConsole } from "@/components/admin/configuration-console";
import { getAdminConfiguration } from "@/server/admin/dal";

export const metadata: Metadata = { title: "Theme and catalog · Operations" };

export default async function AdminConfigurationPage() {
  const data = await getAdminConfiguration();
  return <ConfigurationConsole data={data} />;
}

