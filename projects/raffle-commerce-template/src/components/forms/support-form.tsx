"use client";

import { useActionState } from "react";
import { submitSupportRequest, type FormState } from "@/app/actions/marketing";

const initialState: FormState = {};

export function SupportForm() {
  const [state, action, pending] = useActionState(submitSupportRequest, initialState);
  return (
    <form action={action} className="support-form">
      <label className="honeypot" aria-hidden="true">Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
      {state.success && <div className="form-success" role="status">{state.success}</div>}
      {state.message && <div className="form-alert" role="alert">{state.message}</div>}
      <div className="form-grid">
        <label className="field"><span>Name</span><input name="name" autoComplete="name" required /></label>
        <label className="field"><span>Email</span><input name="email" type="email" autoComplete="email" required /></label>
        <label className="field field-full"><span>Subject</span><input name="subject" required /></label>
        <label className="field field-full"><span>How can we help?</span><textarea name="message" rows={7} minLength={20} required /></label>
      </div>
      <button className="button button-primary" type="submit" disabled={pending}>{pending ? "Sending…" : "Send support request"}</button>
      <p className="legal-short">Never send payment card, password, government ID, tax, or banking information through this form.</p>
    </form>
  );
}
