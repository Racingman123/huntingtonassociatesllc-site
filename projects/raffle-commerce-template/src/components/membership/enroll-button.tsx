"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  acceptMembershipRulesAction,
  joinMembershipAction,
  type MembershipActionState,
} from "@/app/membership/actions";

const initialMembershipActionState: MembershipActionState = { status: "idle" };

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button className="button button-primary button-large" disabled={pending} type="submit">
      {pending ? "Starting membership…" : label}
    </button>
  );
}

export function MembershipEnrollButton({
  planId,
  idempotencyKey,
  signedIn,
  alreadyActive,
  demoMode,
  campaignId,
  officialRulesHref,
  rulesRequired,
  rulesAccepted,
}: {
  planId: string;
  idempotencyKey: string;
  signedIn: boolean;
  alreadyActive: boolean;
  demoMode: boolean;
  campaignId: string;
  officialRulesHref: string;
  rulesRequired: boolean;
  rulesAccepted: boolean;
}) {
  const [state, formAction] = useActionState(joinMembershipAction, initialMembershipActionState);

  if (alreadyActive) {
    return (
      <>
        <a className="button button-primary button-large" href="/account/membership">
          Manage membership
        </a>
        {rulesRequired && !rulesAccepted ? (
          <form action={acceptMembershipRulesAction} className="membership-enroll-form">
            <input name="planId" type="hidden" value={planId} />
            <input name="campaignId" type="hidden" value={campaignId} />
            <label>
              <input name="rulesAccepted" required type="checkbox" />
              <span>I accept the <a href={officialRulesHref}>exact current Official Rules</a> before any membership renewal can receive promotional entries.</span>
            </label>
            <button className="button button-secondary" type="submit">Accept current rules</button>
          </form>
        ) : null}
      </>
    );
  }

  return (
    <form action={formAction} className="membership-enroll-form">
      <input name="planId" type="hidden" value={planId} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      {rulesRequired ? <input name="campaignId" type="hidden" value={campaignId} /> : null}
      {rulesRequired && rulesAccepted ? <input name="rulesAccepted" type="hidden" value="true" /> : null}
      {rulesRequired && !rulesAccepted ? (
        <label>
          <input name="rulesAccepted" required type="checkbox" />
          <span>I accept the <a href={officialRulesHref}>exact current Official Rules</a> governing any promotional entries awarded with this charge.</span>
        </label>
      ) : null}
      <SubmitButton label={signedIn ? "Start monthly membership" : "Sign in to join"} />
      <p>{demoMode
        ? "Demo billing captures the first cycle now."
        : "You’ll continue to Stripe’s hosted checkout. Entries post only after a verified paid invoice."}</p>
      {state.status === "error" ? <p className="membership-enroll-error" role="alert">{state.message}</p> : null}
    </form>
  );
}
