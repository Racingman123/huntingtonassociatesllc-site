"use client";

import { useActionState } from "react";
import { subscribeNewsletter, type FormState } from "@/app/actions/marketing";

const initialState: FormState = {};

export function NewsletterForm() {
  const [state, action, pending] = useActionState(subscribeNewsletter, initialState);
  return (
    <form action={action} className="newsletter-form">
      <div className="newsletter-input-row">
        <label className="sr-only" htmlFor="newsletter-email">Newsletter email address</label>
        <input id="newsletter-email" name="email" type="email" placeholder="Email address" autoComplete="email" required />
        <button className="button button-accent" type="submit" disabled={pending}>{pending ? "Joining…" : "Join the list"}</button>
      </div>
      <label className="check-row check-row-compact">
        <input name="consent" type="checkbox" required />
        <span>Send optional product news and future promotion updates. This does not affect entry or odds.</span>
      </label>
      {(state.success || state.message) && <p className={state.success ? "form-success" : "field-error"} role="status">{state.success ?? state.message}</p>}
    </form>
  );
}
