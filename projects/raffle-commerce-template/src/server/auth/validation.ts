import "server-only";

import type { Route } from "next";
import { z } from "zod";
import { fitsBcryptInput } from "@/lib/password-policy";

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "Email is too long")
  .email("Enter a valid email address");

export const passwordSchema = z
  .string()
  .min(12, "Use at least 12 characters")
  .max(128, "Use no more than 128 characters")
  .refine(fitsBcryptInput, "Use no more than 72 UTF-8 bytes")
  .regex(/[a-z]/, "Include a lowercase letter")
  .regex(/[A-Z]/, "Include an uppercase letter")
  .regex(/[0-9]/, "Include a number")
  .regex(/[^A-Za-z0-9]/, "Include a symbol");

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password").max(128, "Password is too long")
    .refine(fitsBcryptInput, "Password is too long"),
  redirectTo: z.string().max(300).optional(),
});

export const registrationSchema = z
  .object({
    name: z.string().trim().min(2, "Enter your full name").max(100, "Name is too long"),
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    acceptTerms: z.literal("on", {
      error: "You must accept the website terms and privacy notice",
    }),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const passwordRecoveryRequestSchema = z.object({ email: emailSchema });

export const passwordResetSchema = z
  .object({
    token: z.string().trim().min(20, "This reset link is invalid").max(2_048),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const emailVerificationSchema = z.object({
  token: z.string().trim().min(20, "This verification link is invalid").max(2_048),
});

export function safeRedirectPath(
  value: string | undefined,
  fallback: "/account" | "/admin",
): Route {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  try {
    const url = new URL(value, "https://local.invalid");
    if (url.origin !== "https://local.invalid") return fallback;
    return `${url.pathname}${url.search}${url.hash}` as Route;
  } catch {
    return fallback;
  }
}
