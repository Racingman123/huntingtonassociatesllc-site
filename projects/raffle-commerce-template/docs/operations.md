# Operations runbook

The application supplies authenticated workflows and durable evidence; an operator still needs named people, provider reconciliation, legal decisions and incident ownership. Never operate a live campaign by editing rows in a database console.

## Roles and separation of duties

| Capability | Primary owner | Required control |
| --- | --- | --- |
| Brand/catalog draft | Merchandising | Cannot approve rules or draw |
| Rules/jurisdiction review | Promotion counsel/compliance | Written approval tied to exact checksum |
| Legal release | Sponsor admin + compliance witness | Distinct active identities |
| Campaign release | Sponsor admin + compliance witness | Distinct identities, complete evidence/filings |
| AMOE review | Operations/compliance | Rule-based reason and audit trail |
| Refund request | Authorized staff | Explicit money allocation and Stripe intent |
| Frozen-entry adjustment | Operations + compliance | Two distinct decisions; compensating event only |
| Snapshot seal | Reconciliation operator + witness | Independent totals/checksum review |
| Draw | Independent administrator, or segregated demo operator/witness | Immutable custody/result evidence |
| Candidate/winner decision | Administrator/compliance | Ordered alternates, deadline/reason evidence |
| Fulfillment | Operations | Verified winner, clear adjustment gate, delivery evidence |
| Production access | On-call engineering | MFA, time-bound/logged access, no direct ledger edit |

The schema's roles are a foundation, not a full enterprise entitlement model. Production staff access must add enforced MFA/SSO, step-up for sensitive actions, periodic review and break-glass procedure.

## Campaign release package

Keep one immutable evidence package containing:

- sponsor/administrator identity and campaign ID/code;
- tenant bootstrap, initial catalog, theme, legal release, Official Rules and campaign configuration checksums;
- prize ownership/funding, valuation and fulfillment evidence;
- exact purchase, AMOE and membership calculations with worked examples and cap reachability;
- dates, timezone, server instants and eligibility/exclusion matrix;
- approvals for rules, prize funding, AMOE parity, draw procedure and accessibility;
- jurisdiction filing/bond matrix, receipts or counsel-approved no-filing rationale;
- advertisements, landing pages, email/social scripts and short disclosures;
- privacy data map, retention, vendors and marketing-consent design;
- Stripe/email/database/scheduler/tax/fulfillment/draw readiness evidence;
- desktop/mobile/keyboard/accessibility report;
- named approvers and release time.

A material change gets a new checksummed release. Counsel decides whether a live promotion may change and what notice/refiling is required.

## Prelaunch gate

### Configuration and law

- Brand legal name, support address/domain, currency, timezone and public metadata are correct.
- Owned/licensed assets replaced every demo asset and alt text is meaningful.
- Counsel approved the exact Official Rules body/checksum and the campaign references that database row.
- Prize quantity is one, available workflow capacity is one winner, value/cash alternative/restrictions match rules and ads.
- Purchase/AMOE cutoffs and draw time are unambiguous instants; DST boundary tests pass.
- Targeted/date-bounded entry rules, multiplier periods and membership bands are complete and non-ambiguous.
- Storefront/cart/checkout quotes equal authoritative settlement for representative products, discounts, boundaries and caps.
- AMOE is direct, public, mobile/keyboard accessible, marketing-independent and mathematically/operationally consistent with the approved rules.
- Structured eligibility matches rules; address/shipping limitations are not silently substituted for legal eligibility.
- Operational approvals and filing evidence/rationale exist for this exact configuration and rules checksum.

### Runtime

- `DEMO_MODE=false`; seeded users/data/provider IDs are absent, and tenant/staff/catalog were created from archived reviewed manifests.
- Production PostgreSQL migrations, invariant constraints, runtime roles, encrypted backups/PITR and restore test pass.
- Stripe live/test mode, pinned API version, signature secret, Checkout/subscription/refund mapping and reconciliation pass in the chosen environment.
- Resend sender/domain and transactional delivery pass; bounce/complaint/suppression operations are staffed.
- An external scheduler calls maintenance with an independent secret; overlap/latency/failure alerts work.
- Tax quote/commit/refund and fulfillment/tracking/returns integrations are live.
- Staff MFA/SSO and independent draw/custody procedure are live.
- Logs/metrics redact personal data, secrets, session/challenge/receipt tokens and provider payload bodies.
- On-call owners can suspend a campaign/entry path without destroying evidence.

`GET /api/health/ready` should return 200 only after real production gates replace the deliberately action-required tax/fulfillment and MFA/independent-draw checks.

### Rehearsal

Against disposable data and non-live providers, exercise:

1. physical/digital/mixed cart, success, async success, decline/expiry and inventory release;
2. identical and conflicting webhook replay, out-of-order delivery and unknown metadata;
3. full/partial refund, shipping/tax-only allocation and provider failure;
4. AMOE approval/rejection/duplicate/cap/cutoff and appeal escalation;
5. registration, verification, password reset, session revoke and unique/ambiguous guest claim;
6. membership enrollment, initial invoice, renewal replay, past due, cancellation and no-campaign zero-entry cycle;
7. refund and late paid renewal before freeze, after freeze/pre-draw, and post-draw;
8. snapshot build, independent review, two-person seal, candidate rejection and ordered alternate;
9. publication/fulfillment gates and scam/winner communications;
10. backup restore, cutoff outage, provider lag and security incident table-top.

Save the result with the release package.

## Publication and scheduled activation

1. On a new database, validate/plan/bootstrap the tenant with out-of-band ADMIN and COMPLIANCE passwords; archive the non-secret manifest/checksum and unset the secrets.
2. Apply the approved brand release and verify its public checksum/content.
3. Validate/plan/apply the create-only initial catalog as the active admin; archive its checksum and reconcile all asset and recurring Price identities.
4. Publish legal versions with distinct admin/compliance identities; note the Official Rules row/body checksum.
5. Validate and dry-run the campaign overlay. Confirm tenant currency, rules/effective time, no identity/window collision, catalog targets/coverage, plan references, approvals and filing records.
6. Publish with distinct sponsor admin and compliance witness. The release is `SCHEDULED` when the start is future and `LIVE` only when within its approved window.
7. Configure maintenance before start. The scheduler rechecks the exact rules/config/catalog facts and the two role-separated publication approvals, refuses a live competitor, and cancels a schedule that already missed its entry window. The five operational approvals and filing determination were release-time gates; the scheduler does not replace counsel or repeat that review.
8. Verify the public page, exact rules link, countdown, quotes, AMOE, support contact and metadata from clean desktop/mobile sessions.
9. Observe the first capture, grant, AMOE receipt, outbox delivery and reconciliation result.

Do not manually change `Campaign.status`. A direct status edit bypasses audit and prerequisites.

## Maintenance

Call `POST /api/internal/maintenance` with:

```http
Authorization: Bearer <CRON_SECRET>
```

Use a secret of at least 32 characters that differs from `SESSION_SECRET`. Schedule frequently enough for campaign opens/closes and abandoned reservation recovery; one to five minutes is typical during active operations, subject to deployment limits.

Each bounded pass:

- closes the purchase window while preserving an independent later AMOE cutoff;
- opens eligible scheduled campaigns or records activation failures;
- finalizes period-end subscription cancellation;
- revokes expired sessions and prunes old rate buckets/account challenges;
- releases expired Stripe checkout reservations;
- reports pending AMOE/outbox counts;
- leases and delivers a small transactional email batch when Resend is configured.

HTTP 200 means the pass completed without item-level failures; 207 means it completed with one or more reported failures; 401/500 require immediate investigation. Make the external scheduler non-overlapping and alert on missed runs, repeated 207, any 500 or output counters drifting upward.

## Daily reconciliation

Run at least daily and more frequently near close:

- each entry account balance equals its ledger delta sum;
- each entitlement net effect matches origin and never exceeds its recorded grant;
- captured orders withheld after a settlement-time eligibility failure have zero entries and an explicit audit reason;
- Stripe captures/refunds/invoices/subscriptions agree with local orders, payments, refunds and cycles;
- captured lines have the expected entitlement or explicit cap/zero-entry reason;
- refunds match their immutable authorized allocation and cumulative line reversals;
- valid paid cycles are unique, period-contiguous and have either an exact grant or explicit zero-entry reason;
- approved AMOE submissions have one entitlement; pending/rejected submissions have none;
- rules acceptances point to the campaign's exact published rules/checksum;
- inventory reservations/adjustments reconcile to catalog and fulfillment systems;
- webhook and outbox leases are not stale; retries/dead letters/conflicts are explained;
- no unresolved adjustment exists before snapshot/draw/fulfillment;
- provider effective times fall within the rule used for the calculation.

Treat a difference as an integrity incident. Never repair a ledger grant or captured provider fact in place.

## Stripe webhooks

Subscribe the endpoint to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `invoice.paid`
- `invoice_payment.paid`
- `invoice.payment_failed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `refund.created`
- `refund.updated`
- `refund.failed`

The endpoint verifies the raw body, signature, API version and livemode before mapping. Each delivery is claimed by provider event ID plus payload hash. Identical replay returns the recorded result; conflicting replay fails closed. `invoice.paid` and `invoice_payment.paid` normalize to one invoice settlement identity.

Alerts should cover signature/mode/version failures, old unprocessed events, payload conflicts, unknown local identity, amount/currency/fingerprint mismatch, repeated leases, 4xx mapping failures and 5xx processing failures. Independently reconcile Stripe reports; webhook acknowledgement is not settlement proof by itself.

Stripe Connect events are not supported unless explicitly designed and tested.

## Refund procedure

Before initiating, staff should see the order/payment, remaining refundable money, explicit merchandise/shipping/tax allocation, prior allocations, line entries/reversals, campaign lifecycle, fulfillment/return state and predicted adjustment consequence.

1. Verify authority and customer/return basis.
2. Create the refund through the admin workflow; do not issue it first in the Stripe dashboard. The service stores a pending intent/fingerprint before calling Stripe.
3. If the provider call fails, preserve the local failure state and reconcile before retrying.
4. Wait for signed provider settlement. Do not post money from the browser response alone.
5. Confirm allocation, payment/order state, outbox and entry outcome.

For a normal open/reconciling population, cumulative integer allocation appends the exact line reversal. After snapshot freeze, settlement still records money and creates a controlled adjustment:

- operations approves evidence;
- a distinct compliance user approves/rejects the disposition;
- pre-draw approval voids/rebuilds the snapshot after applying the compensating delta;
- post-draw approval may disqualify the affected candidate/winner and advances the ordered alternate; the original snapshot/draw remains evidence;
- unresolved or impermissible state blocks draw/fulfillment and escalates.

Disputes/chargebacks need an external mapping into the same adjustment contract. Until implemented, reconcile and handle under a counsel-approved manual incident procedure without editing provider/ledger rows.

## AMOE review

In demo mode a valid submission may auto-approve. A live workflow should use role-protected review:

- inspect only necessary contact/eligibility and normalized duplicate evidence;
- apply the exact rules consistently; shared IP/device is a signal, not automatic rejection;
- record decision, reviewer, reason/evidence and rules version;
- grant once using the authoritative AMOE rule and shared cap;
- provide cure/appeal escalation and a service target that does not disadvantage the free method;
- retain rejected/duplicate evidence according to approved policy.

The automatic duplicate fingerprint is normalized email + campaign + campaign-local date. It does not prove a person or household identity.

## Membership operations

- Enrollment must resolve one active plan, exact amount/currency/interval and matching Stripe Price.
- New and existing members must accept the exact campaign-bound Official Rules before a paid invoice can receive promotional entries.
- A Checkout completion binds provider customer/subscription; entries come only from a paid invoice, never enrollment alone.
- Every paid invoice is recorded once, even when no campaign/release/band/rules-acceptance/eligibility gate grants entries; the zero reason is part of the cycle calculation evidence.
- A paid invoice arriving after freeze becomes a positive controlled adjustment; do not retry forever or discard it.
- Failed invoices move provider/local status without granting entries.
- Billing Portal changes and `customer.subscription.*` events must reconcile to local status/period/cancel-at-end.
- Maintenance finalizes cancellation only after the paid period ends.

Alert on missing/ambiguous band, price/interval mismatch, paid invoice without local binding, provider/local state drift, stale pending enrollment and unexpected zero-entry cycles.

## Campaign close, snapshot and draw

1. Confirm purchase close and later AMOE cutoff against database/UTC time.
2. Drain and reconcile all events whose effective time can affect the pool.
3. Resolve AMOE, refund, subscription and eligibility exceptions.
4. Build the snapshot. The service refuses unresolved provider/adjustment state and uses the later entry cutoff.
5. Independently compare entrant/account/origin totals and canonical checksum.
6. Two distinct authorized people approve/seal the exact snapshot/checksum.
7. Preserve canonical snapshot and approvals in immutable external evidence storage.
8. Use the Official Rules-approved selection method, preferably an independent administrator.
9. Import/record ordered candidates idempotently; never permit manual alternate choice.

The internal demo draw records a random-seed commitment, encrypted seed and result checksum. Its seed protection derives from application secrets and operator/witness separation is application-level, so it is a rehearsal tool rather than independent production custody.

## Winner verification and fulfillment

- Treat a selected person as provisional.
- Record the disclosed contact deadline and approved contact attempts.
- Verification after the deadline is rejected; disposition and alternate advancement must follow the rules.
- Never request payment, gift cards, cryptocurrency or social credentials to receive a prize.
- Collect identity, affidavit/release and tax documents through a separate private, minimum-access system.
- Publish only after verification and explicit publication consent; expose only approved name/location/media.
- Before delivery, confirm no unresolved adjustment/disqualification and record fulfillment/tracking/title/tax evidence.
- Complete filing/winner-list obligations and retention schedule.

After a post-publication negative adjustment, suspend/qualify the winner state under the approved process and block fulfillment. Do not erase the already-published history.

## Monitoring

`/api/health/live` proves the process responds. `/api/health/ready` checks the database and exposes only check names/statuses; it returns 503 when required configuration or a deliberate launch gate is not ready.

Track and alert on:

- HTTP error rate and p95/p99 latency;
- checkout start→capture and capture→entry latency;
- AMOE submit→decision latency/outcomes;
- oldest webhook/outbox/maintenance lag, retry, lease and dead-letter counts;
- Stripe/local money and subscription differences;
- account/ledger and snapshot differences (must be zero);
- unknown/conflicting idempotency events (must be zero);
- unresolved adjustments approaching draw/fulfillment;
- auth/recovery rate-limit spikes and privileged action volume;
- inventory/fulfillment drift;
- database capacity, backup age and restore-test age.

Page immediately for entry/snapshot/draw/cross-tenant/signature/reconciliation/backup integrity failures.

## Incident playbooks

### Entry miscalculation or late provider fact

Suspend the affected earning path/campaign, preserve the exact code/config/rules/time evidence, independently recompute, notify operations/security/counsel, and use the controlled compensating workflow. Never edit grants. If selected/published/fulfilled state exists, stop advancement/fulfillment and obtain a written remedy decision.

### Webhook forgery, replay or provider drift

Quarantine unverified events, coordinate secret rotation with Stripe, reconcile every transaction from provider reports, inspect event claims/fingerprints and determine whether controlled adjustments are needed.

### Cross-tenant or personal-data exposure

Disable the affected boundary, preserve access evidence, revoke/rotate sessions and credentials as appropriate, scope records/people, involve privacy counsel and follow notification law/runbooks.

### Draw/candidate integrity concern

Stop contact/publication/fulfillment, lock evidence, notify the independent administrator and counsel, verify configuration/snapshot/result checksums and custody. Never rerun or substitute a result without an approved documented basis.

### Cutoff outage

Preserve availability/provider logs for both paid and AMOE paths, suspend misleading ads/countdowns if necessary, prevent ad-hoc staff entries, and have counsel decide extension/cancellation/equal-treatment remedy. Publish only the approved notice/change release.

After any incident, reconcile all external/internal systems, document timeline/root cause, add regression controls/tests and require formal approval before resuming.
