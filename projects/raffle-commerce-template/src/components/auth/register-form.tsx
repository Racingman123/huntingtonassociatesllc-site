"use client";

import Link from "next/link";
import { useActionState } from "react";
import { registerAction } from "@/server/auth/actions";
import { initialAuthActionState } from "@/server/auth/types";
import styles from "./auth.module.css";

export function RegisterForm() {
  const [state, action, pending] = useActionState(registerAction, initialAuthActionState);
  return (
    <>
      <p className={styles.formKicker}>Customer account</p>
      <h2 className={styles.formTitle}>Track every entry.</h2>
      <p className={styles.formIntro}>
        Create a secure account, then verify the email before signing in or attaching any safely matched guest purchases, memberships, or entries. The response does not reveal whether an address was already registered.
      </p>

      <form className={styles.form} action={action} noValidate>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="register-name">Full name</label>
          <input
            className={styles.input}
            id="register-name"
            name="name"
            autoComplete="name"
            required
            aria-invalid={Boolean(state.errors?.name)}
          />
          {state.errors?.name && <p className={styles.fieldError}>{state.errors.name[0]}</p>}
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="register-email">Email address</label>
          <input
            className={styles.input}
            id="register-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            aria-invalid={Boolean(state.errors?.email)}
          />
          {state.errors?.email && <p className={styles.fieldError}>{state.errors.email[0]}</p>}
        </div>
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="register-password">Password</label>
            <input
              className={styles.input}
              id="register-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              aria-invalid={Boolean(state.errors?.password)}
            />
            {state.errors?.password && <p className={styles.fieldError}>{state.errors.password[0]}</p>}
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="register-confirm">Confirm</label>
            <input
              className={styles.input}
              id="register-confirm"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              aria-invalid={Boolean(state.errors?.confirmPassword)}
            />
            {state.errors?.confirmPassword && (
              <p className={styles.fieldError}>{state.errors.confirmPassword[0]}</p>
            )}
          </div>
        </div>
        <label className={styles.checkboxLabel}>
          <input className={styles.checkbox} name="acceptTerms" type="checkbox" required />
          <span>
            I agree to the <Link href="/policies/terms">Website Terms</Link> and acknowledge the{" "}
            <Link href="/policies/privacy">Privacy Notice</Link>. Creating an account does not enter a giveaway.
          </span>
        </label>
        {state.errors?.acceptTerms && (
          <p className={styles.fieldError}>{state.errors.acceptTerms[0]}</p>
        )}
        {state.message && (
          <p className={styles.formMessage} role="alert" aria-live="polite">{state.message}</p>
        )}
        <button className={styles.submit} type="submit" disabled={pending}>
          {pending ? "Creating account…" : "Create account"}
        </button>
      </form>
      <p className={styles.switchPrompt}>
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </>
  );
}
