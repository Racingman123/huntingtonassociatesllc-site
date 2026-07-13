import type { Metadata } from "next";
import { DrawsConsole } from "@/components/admin/draws-console";
import { getAdminDraws } from "@/server/admin/dal";

export const metadata: Metadata = { title: "Draws and winners · Operations" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AdminDrawsPage({ searchParams }: { searchParams: SearchParams }) {
  const [data, query] = await Promise.all([getAdminDraws(), searchParams]);
  return <DrawsConsole data={data} result={{ result: typeof query.result === "string" ? query.result : null, error: typeof query.error === "string" ? query.error : null }} />;
}
