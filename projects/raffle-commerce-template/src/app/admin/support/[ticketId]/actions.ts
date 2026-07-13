"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/server/auth/dal";
import { updateSupportTicketStatus } from "@/server/support/service";

export async function updateSupportTicketAction(formData: FormData) {
  const viewer = await requireStaff();
  const ticketId = String(formData.get("ticketId") ?? "").trim();
  const status = String(formData.get("status") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,191}$/.test(ticketId)) redirect("/admin/audit?error=invalid-ticket");
  try {
    await updateSupportTicketStatus({
      tenantId: viewer.tenantId,
      ticketId,
      actorId: viewer.userId,
      status,
      reason,
    });
  } catch {
    redirect(`/admin/support/${ticketId}?error=transition` as Route);
  }
  revalidatePath("/admin/audit");
  revalidatePath(`/admin/support/${ticketId}`);
  redirect(`/admin/support/${ticketId}?updated=1` as Route);
}
