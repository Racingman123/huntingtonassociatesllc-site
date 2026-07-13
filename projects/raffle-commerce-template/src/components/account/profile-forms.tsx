"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  changePasswordAction,
  signOutOtherSessionsAction,
  updateProfileAction,
} from "@/server/account/actions";
import { initialProfileActionState } from "@/server/account/types";
import styles from "./account.module.css";

export function ProfileForms({ name, phone, email, emailVerified, activeSessionCount }: { name: string; phone: string; email: string; emailVerified: boolean; activeSessionCount: number }) {
  const [profileState, profileAction, profilePending] = useActionState(
    updateProfileAction,
    initialProfileActionState,
  );
  const [passwordState, passwordAction, passwordPending] = useActionState(
    changePasswordAction,
    initialProfileActionState,
  );

  return (
    <div className={styles.formGrid}>
      <section className={styles.panel}>
        <div className={styles.panelHeader}><h2>Profile details</h2></div>
        <form className={styles.settingsForm} action={profileAction}>
          <div className={styles.field}>
            <label htmlFor="profile-name">Full name</label>
            <input className={styles.input} id="profile-name" name="name" defaultValue={name} autoComplete="name" required />
            {profileState.errors?.name && <p className={styles.fieldError}>{profileState.errors.name[0]}</p>}
          </div>
          <div className={styles.field}>
            <label htmlFor="profile-email">Email</label>
            <input className={styles.input} id="profile-email" value={email} disabled readOnly />
          </div>
          <div className={styles.field}>
            <label htmlFor="profile-phone">Phone</label>
            <input className={styles.input} id="profile-phone" name="phone" type="tel" defaultValue={phone} autoComplete="tel" inputMode="tel" required />
            {profileState.errors?.phone && <p className={styles.fieldError}>{profileState.errors.phone[0]}</p>}
          </div>
          <p className={styles.settingsCopy}>Contact support to change the email that identifies your entry account.</p>
          {!emailVerified && (
            <p className={styles.settingsCopy}>
              Verification is still required before prior guest history can be claimed. <Link href="/verify-email/request">Send a verification email</Link>.
            </p>
          )}
          {profileState.message && (
            <p className={styles.formResult} data-status={profileState.status} role="status">{profileState.message}</p>
          )}
          <button className={styles.formButton} type="submit" disabled={profilePending}>
            {profilePending ? "Saving…" : "Save profile"}
          </button>
        </form>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}><h2>Change password</h2></div>
        <form className={styles.settingsForm} action={passwordAction}>
          <div className={styles.field}>
            <label htmlFor="current-password">Current password</label>
            <input className={styles.input} id="current-password" name="currentPassword" type="password" autoComplete="current-password" required />
            {passwordState.errors?.currentPassword && <p className={styles.fieldError}>{passwordState.errors.currentPassword[0]}</p>}
          </div>
          <div className={styles.field}>
            <label htmlFor="new-password">New password</label>
            <input className={styles.input} id="new-password" name="newPassword" type="password" autoComplete="new-password" required />
            {passwordState.errors?.newPassword && <p className={styles.fieldError}>{passwordState.errors.newPassword[0]}</p>}
          </div>
          <div className={styles.field}>
            <label htmlFor="confirm-password">Confirm new password</label>
            <input className={styles.input} id="confirm-password" name="confirmPassword" type="password" autoComplete="new-password" required />
            {passwordState.errors?.confirmPassword && <p className={styles.fieldError}>{passwordState.errors.confirmPassword[0]}</p>}
          </div>
          <p className={styles.settingsCopy}>Use 12+ characters with upper/lowercase letters, a number, and a symbol.</p>
          {passwordState.message && (
            <p className={styles.formResult} data-status={passwordState.status} role="status">{passwordState.message}</p>
          )}
          <button className={styles.formButton} type="submit" disabled={passwordPending}>
            {passwordPending ? "Updating…" : "Change password"}
          </button>
        </form>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}><h2>Active sessions</h2></div>
        <div className={styles.settingsForm}>
          <p className={styles.settingsCopy}>
            {activeSessionCount} active session{activeSessionCount === 1 ? "" : "s"}. Your current browser stays signed in.
          </p>
          <form action={signOutOtherSessionsAction}>
            <button className={`${styles.formButton} ${styles.secondaryButton}`} type="submit">
              Sign out other devices
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
