import type { Metadata } from "next";
import { VerifyEmailForm } from "@/components/auth/account-challenge-forms";
import { AuthShell } from "@/components/auth/auth-shell";
import { getRequestTenant } from "@/server/auth/tenant";

export const metadata: Metadata = {
  title: "Verify email",
  description: "Verify ownership before account history is claimed.",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const [tenant, params] = await Promise.all([getRequestTenant(), searchParams]);
  const token = typeof params.token === "string" ? params.token : "";
  return (
    <AuthShell brandName={tenant.displayName} eyebrow="Verified account history" storyTitle="Prove it before we link it." storyDescription="Guest records are attached only after email ownership is proven and the entrant history has a safe, unambiguous match.">
      <VerifyEmailForm token={token} />
    </AuthShell>
  );
}
