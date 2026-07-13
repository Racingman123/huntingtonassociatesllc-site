import type { Metadata } from "next";
import { LedgerConsole } from "@/components/admin/ledger-console";
import { getAdminLedger } from "@/server/admin/dal";

export const metadata: Metadata = { title: "Entry ledger · Operations" };

export default async function AdminEntriesPage() {
  const data = await getAdminLedger();
  return <LedgerConsole data={data} />;
}

