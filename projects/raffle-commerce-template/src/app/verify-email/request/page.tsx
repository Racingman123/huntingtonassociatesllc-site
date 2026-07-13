import type { Metadata } from "next";
import { AccountChallengeRequestForm } from "@/components/auth/account-challenge-forms";
import { AuthShell } from "@/components/auth/auth-shell";
import { getOptionalViewer } from "@/server/auth/dal";
import { getRequestTenant } from "@/server/auth/tenant";

export const metadata: Metadata = {
  title: "Request email verification",
  description: "Request a single-use email verification link.",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function VerificationRequestPage({ searchParams }: { searchParams: Promise<{ sent?: string | string[]; needed?: string | string[] }> }) {
  const [tenant, viewer, params] = await Promise.all([getRequestTenant(), getOptionalViewer(), searchParams]);
  return (
    <AuthShell brandName={tenant.displayName} eyebrow="Verified account history" storyTitle="One identity. One ledger." storyDescription="Verification is the gate that keeps someone else from claiming guest purchases, memberships, or entries by typing an email address.">
      <AccountChallengeRequestForm
        mode="verify"
        defaultEmail={viewer?.tenantId === tenant.id ? viewer.email : undefined}
        alreadySent={params.sent === "1"}
        verificationRequired={params.needed === "1"}
      />
    </AuthShell>
  );
}
