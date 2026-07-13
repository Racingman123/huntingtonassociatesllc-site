import type { Metadata } from "next";
import { AmoeConsole } from "@/components/admin/amoe-console";
import { getAdminAmoe } from "@/server/admin/dal";

export const metadata: Metadata = { title: "AMOE queue · Operations" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AdminAmoePage({ searchParams }: { searchParams: SearchParams }) {
  const [data, query] = await Promise.all([getAdminAmoe(), searchParams]);
  return <AmoeConsole data={data} result={{ reviewed: typeof query.reviewed === "string" ? query.reviewed : null, error: typeof query.error === "string" ? query.error : null }} />;
}
