import type { Metadata } from "next";
import { AccountChallengeRequestForm } from "@/components/auth/account-challenge-forms";
import { AuthShell } from "@/components/auth/auth-shell";
import { getRequestTenant } from "@/server/auth/tenant";

export const metadata: Metadata = {
  title: "Reset password",
  description: "Request a single-use account recovery link.",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function ForgotPasswordPage() {
  const tenant = await getRequestTenant();
  return (
    <AuthShell brandName={tenant.displayName} eyebrow="Private account recovery" storyTitle="Recover access safely." storyDescription="Recovery links expire after one hour, work once, and never disclose whether an address has an account.">
      <AccountChallengeRequestForm mode="reset" />
    </AuthShell>
  );
}
