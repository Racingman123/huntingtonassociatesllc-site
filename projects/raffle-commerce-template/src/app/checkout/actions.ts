"use server";

import type { Route } from "next";
import { redirect } from "next/navigation";
import { z } from "zod";
import { checkoutInputSchema, completeDemoCheckout } from "@/server/commerce/checkout";
import { startStripeCheckout, startStripeCheckoutForViewer } from "@/server/commerce/stripe-checkout";
import { getRequestTenant } from "@/server/auth/tenant";
import { getOptionalViewer } from "@/server/auth/dal";
import { db } from "@/server/db";
import {
  consumeRateLimits,
  getTrustedClientIp,
  publicRateLimitRules,
} from "@/server/security/rate-limit";

export type CheckoutState = {
  message?: string;
  errors?: Record<string, string[]>;
};

const formSchema = checkoutInputSchema.omit({ lines: true }).extend({
  cart: z.string().min(2),
});

function publicCheckoutError(error: unknown) {
  if (!(error instanceof Error)) return "Checkout could not be completed. Please try again.";
  const safePatterns = [
    /^Store is unavailable$/,
    /^There is no active promotion$/,
    /^Multiple active promotions require an explicit campaign selection$/,
    /^The purchase-entry period is closed$/,
    /^This location is not eligible for the promotion$/,
    /^This entrant is not eligible for the promotion$/,
    /^A cart item cannot have a quantity greater than 20$/,
    /^One or more cart items are no longer available$/,
    /^A selected product option is unavailable$/,
    /^Membership products must be purchased through recurring enrollment$/,
    /^.+ does not have enough inventory$/,
    /^.+ inventory changed; try again$/,
    /^This checkout is no longer payable; refresh the page to start again$/,
    /^This checkout has expired; refresh the page to start again$/,
    /^Hosted checkout is unavailable this close to the promotion deadline$/,
    /^Checkout idempotency key was already used for (?:different customer details|a different cart)$/,
    /^Checkout idempotency key was already used for a different account$/,
    /^Sign-in email must match the checkout email$/,
  ];
  return safePatterns.some((pattern) => pattern.test(error.message))
    ? error.message
    : "Secure checkout could not be started. No payment was captured; please try again.";
}

export async function submitCheckout(_previous: CheckoutState, formData: FormData): Promise<CheckoutState> {
  let lines: unknown;
  try {
    lines = JSON.parse(String(formData.get("cart") ?? "[]"));
  } catch {
    return { message: "Your cart data could not be read. Please return to the cart and try again." };
  }

  const parsed = formSchema.safeParse({
    email: formData.get("email"),
    name: formData.get("name"),
    phone: formData.get("phone"),
    address1: formData.get("address1"),
    address2: formData.get("address2") || undefined,
    city: formData.get("city"),
    region: formData.get("region"),
    postalCode: formData.get("postalCode"),
    country: formData.get("country"),
    ageConfirmed: formData.get("ageConfirmed") === "on",
    rulesAccepted: formData.get("rulesAccepted") === "on",
    marketingConsent: formData.get("marketingConsent") === "on",
    idempotencyKey: formData.get("idempotencyKey"),
    cart: formData.get("cart"),
  });
  if (!parsed.success) {
    return { message: "Please review the highlighted checkout fields.", errors: parsed.error.flatten().fieldErrors };
  }

  const checkout = checkoutInputSchema.safeParse({ ...parsed.data, lines });
  if (!checkout.success) {
    return { message: "Your cart contains an invalid or unavailable item.", errors: checkout.error.flatten().fieldErrors };
  }

  let tenant: Awaited<ReturnType<typeof getRequestTenant>>;
  let authenticatedIdentity: import("@/server/commerce/checkout").AuthenticatedEntrantIdentity | undefined;
  try {
    const [resolvedTenant, trustedIp, viewer] = await Promise.all([
      getRequestTenant(),
      getTrustedClientIp(),
      getOptionalViewer(),
    ]);
    tenant = resolvedTenant;
    const limit = await consumeRateLimits({
      tenantId: tenant.id,
      rules: publicRateLimitRules({
        scope: "checkout-prepare",
        subject: checkout.data.email,
        subjectLimit: 10,
        ip: trustedIp,
        ipLimit: 50,
        windowSeconds: 15 * 60,
      }),
    });
    if (!limit.allowed) {
      return { message: "Too many checkout attempts. Please wait before trying again." };
    }
    if (viewer?.tenantId === tenant.id) {
      if (viewer.email.toLowerCase() !== checkout.data.email.toLowerCase()) {
        return { message: "Sign-in email must match the checkout email" };
      }
      const account = await db.user.findFirst({
        where: { id: viewer.userId, tenantId: tenant.id, status: "ACTIVE", emailVerifiedAt: { not: null } },
        select: { normalizedEmail: true, entrant: { select: { id: true } } },
      });
      if (account?.entrant) {
        authenticatedIdentity = {
          tenantId: tenant.id,
          userId: viewer.userId,
          entrantId: account.entrant.id,
          normalizedEmail: account.normalizedEmail,
        };
      }
    }
  } catch {
    return { message: "Secure checkout is temporarily unavailable. Please try again shortly." };
  }

  try {
    if (process.env.DEMO_MODE === "true") {
      const result = await completeDemoCheckout(checkout.data, tenant.slug, authenticatedIdentity);
      redirect(`/checkout/success?receipt=${encodeURIComponent(result.receipt)}`);
    }
    const result = authenticatedIdentity
      ? await startStripeCheckoutForViewer(checkout.data, tenant.slug, authenticatedIdentity)
      : await startStripeCheckout(checkout.data, tenant.slug);
    redirect(result.redirectUrl as Route);
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    return { message: publicCheckoutError(error) };
  }
}
