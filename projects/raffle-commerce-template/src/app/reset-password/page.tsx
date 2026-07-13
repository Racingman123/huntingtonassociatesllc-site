import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/account-challenge-forms";
import { AuthShell } from "@/components/auth/auth-shell";
import { getRequestTenant } from "@/server/auth/tenant";

export const metadata: Metadata = {
  title: "Choose a new password",
  description: "Use a single-use recovery link to choose a new password.",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const [tenant, params] = await Promise.all([getRequestTenant(), searchParams]);
  const token = typeof params.token === "string" ? params.token : "";
  return (
    <AuthShell brandName={tenant.displayName} eyebrow="Private account recovery" storyTitle="A clean reset." storyDescription="The bearer link is short-lived and single-use. Completing it revokes every existing session.">
      <ResetPasswordForm token={token} />
    </AuthShell>
  );
}
