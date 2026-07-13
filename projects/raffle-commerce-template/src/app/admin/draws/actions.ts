"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/server/auth/dal";
import {
  approveEntrySnapshot,
  buildEntrySnapshot,
  conductDemoDraw,
} from "@/server/draws/operations";
import {
  approveAdjustmentEvidence,
  decideAdjustmentCompliance,
} from "@/server/refunds/adjustments";
import {
  decideDrawCandidate,
  publishVerifiedWinner,
  recordCandidateContact,
  recordWinnerFulfillment,
} from "@/server/winners/service";

function value(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function refreshDrawViews() {
  revalidatePath("/admin");
  revalidatePath("/admin/draws");
  revalidatePath("/admin/audit");
}

export async function buildSnapshotAction(formData: FormData) {
  const viewer = await requireStaff();
  const campaignId = value(formData, "campaignId");
  if (!campaignId) redirect("/admin/draws?error=invalid");
  try {
    await buildEntrySnapshot(campaignId, viewer.userId);
  } catch {
    redirect("/admin/draws?error=reconciliation");
  }
  refreshDrawViews();
  redirect("/admin/draws?result=snapshot-built");
}

export async function approveSnapshotAction(formData: FormData) {
  const viewer = await requireStaff();
  const snapshotId = value(formData, "snapshotId");
  const kind = value(formData, "kind");
  const notes = value(formData, "notes");
  if (!snapshotId || !["OPERATIONS_RECONCILIATION", "COMPLIANCE_WITNESS"].includes(kind)) {
    redirect("/admin/draws?error=invalid");
  }
  try {
    await approveEntrySnapshot({
      snapshotId,
      actorId: viewer.userId,
      kind: kind as "OPERATIONS_RECONCILIATION" | "COMPLIANCE_WITNESS",
      notes,
    });
  } catch {
    redirect("/admin/draws?error=approval");
  }
  refreshDrawViews();
  redirect("/admin/draws?result=snapshot-approved");
}

export async function approveAdjustmentEvidenceAction(formData: FormData) {
  const viewer = await requireStaff();
  try {
    await approveAdjustmentEvidence({
      tenantId: viewer.tenantId,
      requestId: value(formData, "requestId"),
      actorId: viewer.userId,
      evidenceRef: value(formData, "evidenceRef"),
      notes: value(formData, "notes"),
    });
  } catch {
    redirect("/admin/draws?error=adjustment-evidence");
  }
  refreshDrawViews();
  redirect("/admin/draws?result=adjustment-evidence-approved");
}

export async function decideAdjustmentComplianceAction(formData: FormData) {
  const viewer = await requireStaff();
  const disposition = value(formData, "disposition");
  if (![
    "REVERSE_BEFORE_DRAW",
    "APPLY_BEFORE_DRAW",
    "VOID_DRAW_AND_REBUILD",
    "PRESERVE_RESULT",
    "DISQUALIFY_ENTRANT",
  ].includes(disposition)) {
    redirect("/admin/draws?error=invalid");
  }
  try {
    await decideAdjustmentCompliance({
      tenantId: viewer.tenantId,
      requestId: value(formData, "requestId"),
      actorId: viewer.userId,
      disposition,
      notes: value(formData, "notes"),
    });
  } catch {
    redirect("/admin/draws?error=adjustment-decision");
  }
  refreshDrawViews();
  redirect(`/admin/draws?result=adjustment-${disposition.toLowerCase().replaceAll("_", "-")}`);
}

export async function conductDrawAction(formData: FormData) {
  const viewer = await requireStaff();
  const snapshotId = value(formData, "snapshotId");
  if (!snapshotId) redirect("/admin/draws?error=invalid");
  try {
    await conductDemoDraw(snapshotId, viewer.userId, 5);
  } catch {
    redirect("/admin/draws?error=draw");
  }
  refreshDrawViews();
  redirect("/admin/draws?result=draw-conducted");
}

export async function recordCandidateContactAction(formData: FormData) {
  const viewer = await requireStaff();
  const candidateId = value(formData, "candidateId");
  const rawDeadline = value(formData, "contactDeadline");
  const contactDeadline = new Date(rawDeadline);
  if (!candidateId || !rawDeadline || Number.isNaN(contactDeadline.getTime())) {
    redirect("/admin/draws?error=invalid");
  }
  try {
    await recordCandidateContact({
      tenantId: viewer.tenantId,
      candidateId,
      actorId: viewer.userId,
      contactDeadline,
    });
  } catch {
    redirect("/admin/draws?error=candidate-contact");
  }
  refreshDrawViews();
  redirect("/admin/draws?result=candidate-contact-recorded");
}

export async function decideCandidateAction(formData: FormData) {
  const viewer = await requireStaff();
  const candidateId = value(formData, "candidateId");
  const decision = value(formData, "decision");
  const reason = value(formData, "reason");
  if (!candidateId || !["VERIFY", "DISQUALIFY"].includes(decision)) {
    redirect("/admin/draws?error=invalid");
  }
  try {
    await decideDrawCandidate({
      tenantId: viewer.tenantId,
      candidateId,
      actorId: viewer.userId,
      decision,
      reason,
    });
  } catch {
    redirect("/admin/draws?error=candidate-decision");
  }
  refreshDrawViews();
  redirect(`/admin/draws?result=candidate-${decision.toLowerCase()}`);
}

export async function publishWinnerAction(formData: FormData) {
  const viewer = await requireStaff();
  const winnerId = value(formData, "winnerId");
  try {
    await publishVerifiedWinner({
      tenantId: viewer.tenantId,
      winnerId,
      actorId: viewer.userId,
      publicName: value(formData, "publicName"),
      publicLocation: value(formData, "publicLocation"),
      quote: value(formData, "quote") || undefined,
      publicationConsentConfirmed: formData.get("publicationConsentConfirmed") === "on",
    });
  } catch {
    redirect("/admin/draws?error=winner-publication");
  }
  refreshDrawViews();
  revalidatePath("/winners");
  redirect("/admin/draws?result=winner-published");
}

export async function recordWinnerFulfillmentAction(formData: FormData) {
  const viewer = await requireStaff();
  try {
    await recordWinnerFulfillment({
      tenantId: viewer.tenantId,
      winnerId: value(formData, "winnerId"),
      actorId: viewer.userId,
      evidenceReference: value(formData, "evidenceReference"),
    });
  } catch {
    redirect("/admin/draws?error=winner-fulfillment");
  }
  refreshDrawViews();
  revalidatePath("/winners");
  redirect("/admin/draws?result=winner-fulfilled");
}
