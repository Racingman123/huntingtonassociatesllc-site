import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";
import { isStaffRole } from "@/server/auth/config";
import { getOptionalViewer } from "@/server/auth/dal";
import { getRequestTenant } from "@/server/auth/tenant";
import { safeRedirectPath } from "@/server/auth/validation";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to review orders and your promotional entry ledger.",
  robots: { index: false, follow: false },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const [params, viewer, tenant] = await Promise.all([
    searchParams,
    getOptionalViewer(),
    getRequestTenant(),
  ]);
  const next = typeof params.next === "string" ? params.next : undefined;

  if (viewer) {
    const fallback = isStaffRole(viewer.role) ? "/admin" : "/account";
    redirect(safeRedirectPath(next, fallback));
  }

  return (
    <AuthShell
      brandName={tenant.displayName}
      eyebrow="Your entries, accounted for"
      storyTitle="Your account. Your entries. No guesswork."
      storyDescription="Every purchase award, free-entry credit, and reversal belongs in one readable ledger—with the campaign and source attached."
    >
      <LoginForm redirectTo={next} demoEnabled={process.env.DEMO_MODE === "true"} />
    </AuthShell>
  );
}
