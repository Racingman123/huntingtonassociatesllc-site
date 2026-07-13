import type { Metadata } from "next";
import { AccountPageHeader } from "@/components/account/page-header";
import { OrderList } from "@/components/account/order-list";
import { getAccountData } from "@/server/account/dal";
import styles from "@/components/account/account.module.css";

export const metadata: Metadata = { title: "My orders" };

export default async function AccountOrdersPage() {
  const data = await getAccountData();
  return (
    <>
      <AccountPageHeader
        kicker="Purchase history"
        title="Orders"
        description="Payment, fulfillment, line-item, and promotional-entry details for every order linked to this account."
      />
      <section className={styles.panel}>
        <OrderList orders={data.orders} />
      </section>
    </>
  );
}

