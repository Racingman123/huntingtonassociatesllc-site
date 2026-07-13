import type { Metadata } from "next";
import { OrdersConsole } from "@/components/admin/orders-console";
import { getAdminOrders } from "@/server/admin/dal";

export const metadata: Metadata = { title: "Orders · Operations" };

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const data = await getAdminOrders();
  return <OrdersConsole
    data={data}
    result={{
      result: typeof query.result === "string" ? query.result : null,
      error: typeof query.error === "string" ? query.error : null,
    }}
  />;
}
