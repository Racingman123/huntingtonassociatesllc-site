"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaffRole } from "@/server/auth/dal";
import { initiateStripeRefund } from "@/server/refunds/service";

function value(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function moneyToCents(raw: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error("Invalid monetary amount");
  const [whole, fraction = ""] = raw.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("Invalid monetary amount");
  return cents;
}

export async function initiateStripeRefundAction(formData: FormData) {
  const viewer = await requireStaffRole(["ADMIN", "OPERATIONS"]);
  if (formData.get("confirmed") !== "on") redirect("/admin/orders?error=confirmation-required");
  try {
    await initiateStripeRefund({
      tenantId: viewer.tenantId,
      orderId: value(formData, "orderId"),
      actorId: viewer.userId,
      amountCents: moneyToCents(value(formData, "amount")),
      merchandiseCents: moneyToCents(value(formData, "merchandiseAmount")),
      shippingCents: moneyToCents(value(formData, "shippingAmount")),
      taxCents: moneyToCents(value(formData, "taxAmount")),
      reason: value(formData, "reason"),
      evidence: value(formData, "evidence"),
      providerReason: value(formData, "providerReason"),
      idempotencyKey: value(formData, "idempotencyKey"),
    });
  } catch {
    redirect("/admin/orders?error=refund-request-failed");
  }
  revalidatePath("/admin");
  revalidatePath("/admin/orders");
  revalidatePath("/admin/ledger");
  redirect("/admin/orders?result=refund-requested");
}
