import type { Metadata } from "next";
import { AccountPageHeader } from "@/components/account/page-header";
import { ProfileForms } from "@/components/account/profile-forms";
import { getAccountData } from "@/server/account/dal";

export const metadata: Metadata = { title: "Profile and security" };

export default async function AccountProfilePage() {
  const data = await getAccountData();
  return (
    <>
      <AccountPageHeader
        kicker="Account settings"
        title="Profile & security"
        description="Manage your display name, contact phone, password, and active database sessions."
      />
      <ProfileForms
        name={data.viewer.name}
        phone={data.entrant?.phone ?? ""}
        email={data.viewer.email}
        emailVerified={Boolean(data.viewer.emailVerifiedAt)}
        activeSessionCount={data.viewer.activeSessionCount}
      />
    </>
  );
}
