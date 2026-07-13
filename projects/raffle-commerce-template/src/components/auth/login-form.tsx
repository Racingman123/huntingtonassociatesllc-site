"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { loginAction } from "@/server/auth/actions";
import { initialAuthActionState } from "@/server/auth/types";
import styles from "./auth.module.css";

const demos = {
  customer: { email: "alex@example.com", password: "DemoCustomer!234" },
  staff: { email: "admin@example.com", password: "DemoAdmin!234" },
} as const;

export function LoginForm({ redirectTo, demoEnabled }: { redirectTo?: string; demoEnabled: boolean }) {
  const [state, action, pending] = useActionState(loginAction, initialAuthActionState);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function fillDemo(kind: keyof typeof demos) {
    setEmail(demos[kind].email);
    setPassword(demos[kind].password);
  }

  return (
    <>
      <p className={styles.formKicker}>Secure account access</p>
      <h2 className={styles.formTitle}>Welcome back.</h2>
      <p className={styles.formIntro}>
        Sign in to review orders, see every entry credit, and follow your giveaway history.
      </p>

      <form className={styles.form} action={action} noValidate>
        <input type="hidden" name="redirectTo" value={redirectTo ?? ""} />
        <div className={styles.field}>
          <label className={styles.label} htmlFor="login-email">Email address</label>
          <input
            className={styles.input}
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={Boolean(state.errors?.email)}
            aria-describedby={state.errors?.email ? "login-email-error" : undefined}
          />
          {state.errors?.email && (
            <p className={styles.fieldError} id="login-email-error">{state.errors.email[0]}</p>
          )}
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="login-password">
            Password <Link href="/forgot-password">Forgot?</Link>
          </label>
          <input
            className={styles.input}
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={Boolean(state.errors?.password)}
            aria-describedby={state.errors?.password ? "login-password-error" : undefined}
          />
          {state.errors?.password && (
            <p className={styles.fieldError} id="login-password-error">{state.errors.password[0]}</p>
          )}
        </div>
        {state.message && (
          <p className={styles.formMessage} role="alert" aria-live="polite">{state.message}</p>
        )}
        <button className={styles.submit} type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className={styles.switchPrompt}>
        New here? <Link href="/register">Create an account</Link>. Need a new verification email? <Link href="/verify-email/request">Request one</Link>.
      </p>

      {demoEnabled && (
        <aside className={styles.demoBox} aria-label="Demo login credentials">
          <div className={styles.demoHeader}>
            <strong>Template demo credentials</strong>
            <span className={styles.demoBadge}>Demo only</span>
          </div>
          <div className={styles.demoGrid}>
            <button className={styles.demoButton} type="button" onClick={() => fillDemo("customer")}>
              <strong>Customer account</strong>
              <code>alex@example.com</code>
              <code>DemoCustomer!234</code>
            </button>
            <button className={styles.demoButton} type="button" onClick={() => fillDemo("staff")}>
              <strong>Staff console</strong>
              <code>admin@example.com</code>
              <code>DemoAdmin!234</code>
            </button>
          </div>
        </aside>
      )}
    </>
  );
}
