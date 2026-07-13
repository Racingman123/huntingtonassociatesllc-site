import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { RegisterForm } from "@/components/auth/register-form";
import { isStaffRole } from "@/server/auth/config";
import { getOptionalViewer } from "@/server/auth/dal";
import { getRequestTenant } from "@/server/auth/tenant";

export const metadata: Metadata = {
  title: "Create an account",
  description: "Create a customer account to review orders and promotional entries.",
  robots: { index: false, follow: false },
};

export default async function RegisterPage() {
  const [viewer, tenant] = await Promise.all([getOptionalViewer(), getRequestTenant()]);
  if (viewer) redirect(isStaffRole(viewer.role) ? "/admin" : "/account");

  return (
    <AuthShell
      brandName={tenant.displayName}
      eyebrow="Built for transparent promotions"
      storyTitle="See the trail behind every entry."
      storyDescription="Your account connects qualifying orders and free entries to an append-only ledger, so the number you see always has a source."
    >
      <RegisterForm />
    </AuthShell>
  );
}
