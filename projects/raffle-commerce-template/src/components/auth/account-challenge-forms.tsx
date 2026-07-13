"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  requestEmailVerificationAction,
  requestPasswordResetAction,
  resetPasswordAction,
  verifyEmailAction,
} from "@/server/auth/challenge-actions";
import { initialAccountChallengeActionState } from "@/server/auth/types";
import styles from "./auth.module.css";

export function AccountChallengeRequestForm({
  mode,
  defaultEmail,
  alreadySent = false,
  verificationRequired = false,
}: {
  mode: "verify" | "reset";
  defaultEmail?: string;
  alreadySent?: boolean;
  verificationRequired?: boolean;
}) {
  const serverAction = mode === "verify" ? requestEmailVerificationAction : requestPasswordResetAction;
  const [state, action, pending] = useActionState(serverAction, initialAccountChallengeActionState);
  const verifying = mode === "verify";
  const message = state.message ?? (alreadySent
    ? "If an eligible account matches that address, an email with the next step will be sent shortly."
    : verificationRequired
      ? "Email verification is required before sign-in. Request a single-use verification link below."
      : undefined);
  return (
    <>
      <p className={styles.formKicker}>{verifying ? "Account verification" : "Account recovery"}</p>
      <h2 className={styles.formTitle}>{verifying ? "Check your inbox." : "Reset access."}</h2>
      <p className={styles.formIntro}>
        {verifying
          ? "Verification proves ownership before any prior guest orders, memberships, or entry history can be attached to this account."
          : "Enter your account email. For privacy, the response is the same whether or not an eligible account exists."}
      </p>
      <form className={styles.form} action={action} noValidate>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${mode}-email`}>Email address</label>
          <input
            className={styles.input}
            id={`${mode}-email`}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            defaultValue={defaultEmail}
            readOnly={Boolean(defaultEmail)}
            required
            aria-invalid={Boolean(state.errors?.email)}
          />
          {state.errors?.email && <p className={styles.fieldError}>{state.errors.email[0]}</p>}
        </div>
        {message && (
          <p className={styles.formMessage} role="status" aria-live="polite">{message}</p>
        )}
        <button className={styles.submit} type="submit" disabled={pending}>
          {pending ? "Submitting…" : verifying ? "Send verification email" : "Send reset email"}
        </button>
      </form>
      <p className={styles.switchPrompt}>
        <Link href={defaultEmail ? "/account" : "/login"}>{defaultEmail ? "Return to account" : "Return to sign in"}</Link>
      </p>
    </>
  );
}

export function VerifyEmailForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(verifyEmailAction, initialAccountChallengeActionState);
  return (
    <>
      <p className={styles.formKicker}>Single-use verification</p>
      <h2 className={styles.formTitle}>Confirm ownership.</h2>
      <p className={styles.formIntro}>
        We will connect only a safely matched guest history. Conflicting populated records are held for staff review and never silently merged.
      </p>
      <form className={styles.form} action={action}>
        <input type="hidden" name="token" value={token} />
        {state.message && (
          <p className={styles.formMessage} role="status" aria-live="polite">{state.message}</p>
        )}
        {state.status !== "success" && (
          <button className={styles.submit} type="submit" disabled={pending || !token}>
            {pending ? "Verifying…" : "Verify email"}
          </button>
        )}
      </form>
      <p className={styles.switchPrompt}>
        {state.status === "success" ? <Link href="/login">Sign in</Link> : <Link href="/verify-email/request">Request a new link</Link>}
      </p>
    </>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(resetPasswordAction, initialAccountChallengeActionState);
  return (
    <>
      <p className={styles.formKicker}>Single-use recovery</p>
      <h2 className={styles.formTitle}>Choose a password.</h2>
      <p className={styles.formIntro}>
        Use 12–128 characters with uppercase and lowercase letters, a number, and a symbol. A successful reset signs out every existing session.
      </p>
      <form className={styles.form} action={action} noValidate>
        <input type="hidden" name="token" value={token} />
        <div className={styles.field}>
          <label className={styles.label} htmlFor="reset-password">New password</label>
          <input className={styles.input} id="reset-password" name="password" type="password" autoComplete="new-password" required aria-invalid={Boolean(state.errors?.password)} />
          {state.errors?.password && <p className={styles.fieldError}>{state.errors.password[0]}</p>}
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="reset-confirm">Confirm password</label>
          <input className={styles.input} id="reset-confirm" name="confirmPassword" type="password" autoComplete="new-password" required aria-invalid={Boolean(state.errors?.confirmPassword)} />
          {state.errors?.confirmPassword && <p className={styles.fieldError}>{state.errors.confirmPassword[0]}</p>}
        </div>
        {state.message && (
          <p className={styles.formMessage} role="status" aria-live="polite">{state.message}</p>
        )}
        {state.status !== "success" && (
          <button className={styles.submit} type="submit" disabled={pending || !token}>
            {pending ? "Resetting…" : "Reset password"}
          </button>
        )}
      </form>
      <p className={styles.switchPrompt}>
        {state.status === "success" ? <Link href="/login">Sign in</Link> : <Link href="/forgot-password">Request a new link</Link>}
      </p>
    </>
  );
}
