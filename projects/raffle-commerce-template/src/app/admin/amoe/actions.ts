"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/server/auth/dal";
import { reviewFreeEntry } from "@/server/entries/review";

const REVIEW_ROLES = new Set(["ADMIN", "OPERATIONS", "COMPLIANCE"]);

export async function reviewAmoeAction(formData: FormData) {
  const viewer = await requireStaff();
  if (!REVIEW_ROLES.has(viewer.role.toUpperCase())) redirect("/admin/amoe?error=forbidden");

  const decision = String(formData.get("decision") ?? "").toUpperCase();
  const submissionId = String(formData.get("submissionId") ?? "");
  const reason = String(formData.get("reason") ?? "");
  if (!submissionId || !["APPROVE", "REJECT"].includes(decision)) {
    redirect("/admin/amoe?error=invalid");
  }

  try {
    await reviewFreeEntry({
      tenantId: viewer.tenantId,
      submissionId,
      actorId: viewer.userId,
      decision,
      reason,
    });
  } catch {
    redirect("/admin/amoe?error=review");
  }

  revalidatePath("/admin/amoe");
  revalidatePath("/admin/entries");
  revalidatePath("/account/entries");
  redirect(`/admin/amoe?reviewed=${decision.toLowerCase()}`);
}
