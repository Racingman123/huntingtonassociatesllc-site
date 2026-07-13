import "server-only";

import { z } from "zod";
import { passwordSchema } from "@/server/auth/validation";
import { phoneSchema } from "@/lib/phone";

export const profileSchema = z.object({
  name: z.string().trim().min(2, "Enter your full name").max(100, "Name is too long"),
  phone: phoneSchema,
});

export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password").max(128),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((value) => value.newPassword === value.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: "Choose a password you have not just used",
    path: ["newPassword"],
  });
