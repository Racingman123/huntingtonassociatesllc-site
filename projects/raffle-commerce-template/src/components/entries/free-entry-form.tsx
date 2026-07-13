"use client";

import { useActionState } from "react";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { freeEntryAction, type FreeEntryState } from "@/app/giveaways/[campaignSlug]/free-entry/actions";
import { formatEntries } from "@/lib/format";
import type { OfficialRulesHref } from "@/lib/official-rules";

const initialState: FreeEntryState = {};

function ErrorText({ values }: { values?: string[] }) {
  return values?.[0] ? <span className="field-error">{values[0]}</span> : null;
}

export function FreeEntryForm({
  campaignSlug,
  awardEntries,
  minimumAge,
  eligibleCountries,
  officialRulesHref,
}: {
  campaignSlug: string;
  awardEntries: bigint;
  minimumAge: number;
  eligibleCountries: string[];
  officialRulesHref: OfficialRulesHref;
}) {
  const [state, action, pending] = useActionState(freeEntryAction, initialState);
  if (state.success) {
    return (
      <div className="free-entry-success" role="status">
        <CheckCircle2 aria-hidden="true" size={52} />
        <p className="eyebrow">ENTRY RECORDED</p>
        <h2>No purchase. Same prize pool.</h2>
        <p>Your confirmation code is <strong>{state.success.confirmationCode}</strong>.</p>
        <div className="success-entry-total">
          <span>{state.success.status === "APPROVED" ? "Entries posted" : "Entries pending review"}</span>
          <strong>{formatEntries(state.success.entries)}</strong>
        </div>
        <p>Save this confirmation. You can submit one valid free entry per normalized email per campaign calendar day while the period is open. The administrator reviews duplicate identities and applies the person-level cap in the Official Rules across every entry method.</p>
        <Link className="button button-secondary" href={`/giveaways/${campaignSlug}`}>Back to giveaway</Link>
      </div>
    );
  }

  return (
    <form action={action} className="free-entry-form" noValidate>
      <input name="campaignSlug" type="hidden" value={campaignSlug} />
      <label className="honeypot" aria-hidden="true">
        Website
        <input name="website" tabIndex={-1} autoComplete="off" />
      </label>
      {state.message && <div className="form-alert" role="alert">{state.message}</div>}
      <div className="form-grid">
        <label className="field field-full">
          <span>Full legal name</span>
          <input name="name" autoComplete="name" required />
          <ErrorText values={state.errors?.name} />
        </label>
        <label className="field field-full">
          <span>Email</span>
          <input name="email" type="email" autoComplete="email" required />
          <ErrorText values={state.errors?.email} />
        </label>
        <label className="field field-full">
          <span>Phone</span>
          <input name="phone" type="tel" autoComplete="tel" inputMode="tel" required />
          <ErrorText values={state.errors?.phone} />
        </label>
        <label className="field">
          <span>Country</span>
          <select name="country" defaultValue={eligibleCountries[0]} required>
            {eligibleCountries.map((country) => <option key={country} value={country}>{country}</option>)}
          </select>
          <ErrorText values={state.errors?.country} />
        </label>
        <label className="field">
          <span>State / province / region</span>
          <input name="region" autoComplete="address-level1" required />
          <ErrorText values={state.errors?.region} />
        </label>
        <label className="field">
          <span>Postal code</span>
          <input name="postalCode" autoComplete="postal-code" required />
          <ErrorText values={state.errors?.postalCode} />
        </label>
      </div>
      <fieldset className="consent-group">
        <legend>Eligibility confirmations</legend>
        <label className="check-row">
          <input name="ageConfirmed" type="checkbox" required />
          <span>I confirm I am at least {minimumAge} and the age of majority where I live.</span>
        </label>
        <label className="check-row">
          <input name="residenceConfirmed" type="checkbox" required />
          <span>I am a legal resident of an eligible location and meet the displayed eligibility requirements.</span>
        </label>
        <label className="check-row">
          <input name="rulesAccepted" type="checkbox" required />
          <span>I have read and accept the <Link href={officialRulesHref} target="_blank">Official Rules</Link>.</span>
        </label>
      </fieldset>
      <button className="button button-primary button-block" disabled={pending} type="submit">
        {pending ? "Recording entry…" : `Submit free entry — ${formatEntries(awardEntries)} entries`}
      </button>
      <p className="legal-short">No marketing consent is requested or required. We use this information only to administer the promotion as described in the <Link href="/policies/privacy">Privacy Notice</Link>.</p>
    </form>
  );
}
