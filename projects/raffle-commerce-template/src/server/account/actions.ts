"use server";

import { compare, hash } from "bcryptjs";
import { revalidatePath } from "next/cache";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth/dal";
import type { ProfileActionState } from "./types";
import { passwordChangeSchema, profileSchema } from "./validation";

export async function updateProfileAction(
  _previousState: ProfileActionState,
  formData: FormData,
): Promise<ProfileActionState> {
  const viewer = await requireUser();
  const parsed = profileSchema.safeParse({
    name: formData.get("name"),
    phone: formData.get("phone"),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: "Check the highlighted field.",
      errors: parsed.error.flatten().fieldErrors,
    };
  }

  await db.$transaction([
    db.user.update({
      where: { id: viewer.userId },
      data: { name: parsed.data.name },
    }),
    db.entrant.updateMany({
      where: { userId: viewer.userId, tenantId: viewer.tenantId },
      data: { name: parsed.data.name, phone: parsed.data.phone },
    }),
    db.auditEvent.create({
      data: {
        tenantId: viewer.tenantId,
        actorType: "USER",
        actorId: viewer.userId,
        action: "PROFILE_UPDATED",
        resourceType: "User",
        resourceId: viewer.userId,
        metadataJson: JSON.stringify({ fields: ["name", "phone"] }),
      },
    }),
  ]);

  revalidatePath("/account/profile");
  return { status: "success", message: "Profile updated." };
}

export async function changePasswordAction(
  _previousState: ProfileActionState,
  formData: FormData,
): Promise<ProfileActionState> {
  const viewer = await requireUser();
  const parsed = passwordChangeSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: "Check the highlighted fields.",
      errors: parsed.error.flatten().fieldErrors,
    };
  }

  const user = await db.user.findFirst({
    where: { id: viewer.userId, tenantId: viewer.tenantId, status: "ACTIVE" },
    select: { passwordHash: true },
  });
  if (!user || !(await compare(parsed.data.currentPassword, user.passwordHash))) {
    return {
      status: "error",
      message: "The current password is incorrect.",
      errors: { currentPassword: ["Current password is incorrect"] },
    };
  }

  const passwordHash = await hash(parsed.data.newPassword, 12);
  await db.$transaction([
    db.user.update({
      where: { id: viewer.userId },
      data: { passwordHash },
    }),
    db.session.updateMany({
      where: {
        userId: viewer.userId,
        tenantId: viewer.tenantId,
        id: { not: viewer.sessionId },
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    }),
    db.auditEvent.create({
      data: {
        tenantId: viewer.tenantId,
        actorType: "USER",
        actorId: viewer.userId,
        action: "PASSWORD_CHANGED",
        resourceType: "User",
        resourceId: viewer.userId,
      },
    }),
  ]);

  revalidatePath("/account/profile");
  return {
    status: "success",
    message: "Password changed. Other sessions were signed out.",
  };
}

export async function signOutOtherSessionsAction() {
  const viewer = await requireUser();
  const result = await db.session.updateMany({
    where: {
      userId: viewer.userId,
      tenantId: viewer.tenantId,
      id: { not: viewer.sessionId },
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { revokedAt: new Date() },
  });

  await db.auditEvent.create({
    data: {
      tenantId: viewer.tenantId,
      actorType: "USER",
      actorId: viewer.userId,
      action: "OTHER_SESSIONS_REVOKED",
      resourceType: "Session",
      metadataJson: JSON.stringify({ count: result.count }),
    },
  });
  revalidatePath("/account/profile");
}
