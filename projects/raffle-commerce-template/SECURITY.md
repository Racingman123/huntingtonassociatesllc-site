# Security policy

## Status and reporting

This repository is a reusable application template, not a hosted service, certified sweepstakes platform or long-term-support release. Only the current default branch is expected to receive fixes. A production operator must publish its own monitored security contact, supported versions, response targets and participant-notification process.

Do not put secrets, personal data, session tokens, payment payloads, entrant exports or draw evidence in a public issue. Report a suspected vulnerability through a private security advisory or another verified private channel to the repository owner. Include the affected revision/environment, impact, prerequisites, concise reproduction and scope. Do not test against a live campaign or access data that is not yours.

## Security objectives

The system prioritizes:

1. **Entry integrity:** earned grants are neither lost nor inflated; caps, reversals, eligibility and post-freeze changes follow one auditable policy.
2. **Draw integrity:** the eligible population, snapshot checksum, approvals, selection method, ordered candidates and later dispositions remain reconstructable.
3. **Payment integrity:** only authoritative provider events change captured/refunded money and associated entries, exactly once.
4. **Tenant isolation:** one brand cannot read or mutate another brand's participants, staff, catalog, configuration, evidence or provider events.
5. **Authorization and separation of duties:** customers see only owned records; sensitive staff transitions are reauthorized and material controls require distinct people.
6. **Privacy:** credentials, entrant data, winner documents, provider secrets and operational evidence are minimized and access-controlled.
7. **Availability and fairness:** paid and no-purchase paths honor the same approved clock and failures can be reconciled consistently.
8. **Auditability:** material decisions retain actor, reason, exact configuration/rules versions and time.

## Implemented controls

These controls are meaningful foundations, but require independent review in the operator's deployment.

### Authentication and participant identity

- bcrypt password hashing and generic-error login/recovery responses.
- Cryptographically random opaque session tokens; only HMAC-SHA-256 digests are stored.
- HTTP-only, `SameSite=Lax`, path-scoped cookies with `Secure` in production.
- Database checks for session hash, expiry/revocation, tenant, user state and role on every protected read/action.
- Single-use, one-hour verification/recovery challenges represented by HMAC digests in the database; delivery tokens are reconstructed only while rendering the transactional message.
- Password reset revokes every existing session; account controls can revoke all other sessions.
- Unverified users do not receive authenticated sessions.
- Verified-email claim of matching guest history; ambiguous ownership creates a review ticket instead of silently attaching records.
- Safe redirect parsing, no-referrer/noindex recovery pages and rate limits on authentication/recovery flows.

Email verification proves control of an address, not a natural person's legal identity or household. Provisional-winner identity belongs in a separate secure verification process.

### Application and tenant boundaries

- Zod parsing for public, customer, staff, provider and release-tool inputs.
- Server-only provider/database modules and Server Action reauthorization.
- Tenant-scoped queries and compound uniqueness in core models.
- Trusted-host tenant resolution and a configuration switch that ignores forwarded headers unless an operator explicitly trusts a sanitizing proxy.
- Server-authoritative prices, product/variant status, inventory, campaign clock, entry rule, multiplier, eligibility and cap.
- Integer cents and `bigint` entries; deterministic arithmetic with boundary tests.
- CSP, anti-framing, MIME-sniffing, referrer and permissions headers; conservative production HSTS.
- Honeypots, bounded request bodies and database-backed rate-limit buckets on abuse-prone routes.

Application filters are not a substitute for independently reviewed database isolation. Add restricted database roles and, where appropriate, row-level controls in production.

### Payments, refunds and recurring billing

- Stripe-hosted one-time and recurring Checkout rather than application collection of card data.
- Raw-body webhook signature verification, maximum body size, pinned SDK API version and explicit test/live-mode match.
- Provider delivery claims, stale-lease recovery, replay idempotency, payload fingerprint conflicts and terminal outcome persistence.
- Checkout metadata contracts bind tenant, order, amount/currency and cart fingerprint.
- Capture settlement reloads the prepared order, inventory reservation and authoritative campaign/rules state.
- Refund initiation creates a pending local intent and sends an `order-refund-v1` metadata contract with immutable merchandise/shipping/tax allocation; webhook settlement must match that authorization.
- Refund money is recorded even when promotional entries have already frozen. Entry impact becomes a controlled adjustment rather than being dropped or forcing endless webhook retry.
- Recurring invoice settlement records every valid paid cycle, including zero-entry cycles and payments arriving after snapshot freeze.
- Late positive/negative entry effects require role-separated evidence/compliance decisions. Before a draw they invalidate and rebuild the snapshot; after a draw they preserve evidence and may disqualify affected candidates under the approved rules.

Remaining operator work includes dispute/chargeback event mapping, daily provider-to-ledger reconciliation, alerting, live-account access controls, tax configuration and documented refund/chargeback policy.

### Rules, entries and draw custody

- Every campaign binds an exact published Official Rules record and checksum. Public reads and entry mutations fail closed on a missing/mismatched relation.
- Rules acceptance stores entrant, method, document and checksum separately from optional marketing consent.
- Campaign, legal and theme releases use deterministic checksums and versioned publication records; published legal rows and exact campaign-to-rules bindings are database-immutable in the SQLite demo.
- Purchase, AMOE and membership grants share a tenant/campaign/entrant account and append-only ledger.
- Targeted and time-bounded entry rules are evaluated authoritatively and calculation inputs are snapshotted on the earning record.
- SQLite demo triggers reject in-place ledger/audit/sealed-snapshot and published-release changes. Production needs equivalent database invariants.
- Snapshot construction checks unresolved adjustments/provider events, reconciles entry balances and writes canonical ranges plus checksum.
- Distinct staff identities approve and seal a snapshot. The internal demo draw records seed/result commitments and ordered candidates.
- Winner verification deadlines, candidate dispositions, publication consent, post-publication adjustment handling and fulfillment gates are explicit transitions.

The internal selection is a demonstrable auditable procedure, not a claim of independent custody. A real campaign should use the counsel-approved method and preferably an independent administrator/custodian with its own evidence and KMS boundary.

### Email, maintenance and audit

- Transactional events are durable outbox rows created with the domain transaction.
- The Resend worker uses bounded batches, leases, idempotency keys, retries and terminal failure states; it renders current authoritative state and cancels stale messages.
- Maintenance uses an independent bearer secret, bounded work and idempotent operations for campaign transitions, cancellations, expired sessions/challenges/rate buckets, abandoned Stripe reservations and email delivery.
- Material domain actions append tenant-scoped audit events with safe metadata.
- CI runs dependency audit, database setup, lint, typecheck, unit/integration tests, production build and desktop/mobile browser tests.

Production still needs bounce/complaint/suppression processing, a distributed scheduler/queue with overlap control, provider monitoring, centralized redacted logs and incident alerts.

## Deliberate production gates

`/api/health/ready` intentionally cannot become production-ready from secrets alone. It requires PostgreSQL and live Stripe/email/maintenance configuration, and retains explicit action-required gates for:

- a real tax engine and fulfillment consumer/reconciliation path;
- enforced staff MFA/SSO and an approved independent draw/custody integration.

Replace a static gate only when the corresponding live control has a meaningful health/assurance check.

## Known gaps and risk decisions

### Infrastructure and data

- The checked-in database workflow uses SQLite and `db push`; production PostgreSQL migrations, constraints, restricted roles, backup/PITR and restore tests are not included.
- Some domain statuses/kinds remain strings; database constraints should mirror application state machines.
- `EntryAccount.balance` is a denormalized projection and needs scheduled independent reconciliation.
- Stable email hashes/fingerprints are pseudonymous identifiers, not anonymization.
- Automated data export/deletion/retention/legal-hold workflows and isolated winner-document storage are not shipped.
- The demo's fictional filing evidence, approvals, money and winner records must never be promoted to production.

### Identity, abuse and staff access

- Customer/staff authentication is password-based. Enforced MFA, passkeys/SSO, step-up authentication, breached-password screening and automated access reviews are external launch requirements.
- Database rate limits are intentionally simple; high-volume production needs distributed enforcement, bot/challenge signals and accessible alternatives.
- The automatic AMOE duplicate key is normalized email + campaign + local date. Natural-person/household limits require fair human review and appeal evidence; do not claim the fingerprint proves them.
- Secure winner identity/tax-document collection, malware scanning and restricted object storage are not included.
- Staff roles are coarse compared with a mature capability/approval system.

### Web and provider hardening

- The CSP permits framework-required inline script/style execution; narrow provider/connect/style origins to the actual deployment and regression-test it.
- Trusted proxy/host handling, TLS/HSTS ownership and edge cache behavior need deployment-specific validation.
- No standalone CSRF-token framework is used. `SameSite=Lax`, same-origin actions and framework checks reduce risk, but every new cross-origin or mutating endpoint requires deliberate origin/CSRF review.
- Stripe disputes/chargebacks are not yet converted to entry-adjustment events.
- Resend bounce, complaint, unsubscribe and suppression propagation are not included.
- Tax, address validation, shipping, 3PL/warehouse and returns systems are not integrated.

### Legal and operational assurance

- Configuration validation cannot determine whether a sweepstakes is lawful, whether a filing/bond is required or whether an AMOE is sufficiently equal in a specific jurisdiction.
- “Raffle” and “lottery” structures may be unlawful for ordinary commercial operators. The template's default model is no-purchase-necessary sweepstakes administration.
- The operator must substantiate the prize, secure written approvals/evidence, file/register/bond where required, and review all advertising/checkout/subscription/refund claims.
- The system cannot prevent a privileged infrastructure/database insider from bypassing the application. Independent evidence storage, custody, database audit and organizational separation remain important.

## Threat-model checklist

Review at least these paths for each deployment:

- cart/checkout tampering with price, variant, quantity, currency, tenant, multiplier or redirect;
- bot-farmed AMOE, account creation, recovery, support or inventory exhaustion;
- replay/race of checkout, refund, renewal, AMOE review or entry-cap updates;
- forged, replayed, out-of-order or conflicting provider events;
- late capture/refund/renewal across campaign cutoff, snapshot freeze, draw and fulfillment;
- credential stuffing, stolen sessions or recovery-mail compromise;
- cross-tenant host/header/query confusion;
- compromised staff granting/reversing entries, changing rules, substituting a snapshot or manipulating candidate disposition;
- privileged database/infrastructure access disabling invariants or replacing artifacts;
- dependency/build/provider compromise and secret exfiltration;
- winner impersonation/phishing and unsafe claim-document handling;
- unequal paid/AMOE outage or review treatment around cutoffs;
- backup/restore that loses provider events or resurrects stale campaign state.

Integrity/fairness incidents can create legal obligations even when no conventional confidentiality breach occurred. Model them with promotion counsel and operations, not only security engineering.

## Secrets and key management

- Generate independent high-entropy secrets; never commit `.env` or paste secrets/tokens into logs, tickets or chat.
- Isolate keys/accounts per environment and use least-privilege workload identity where available.
- Separate session HMAC, rate-limit HMAC, maintenance bearer, webhook, provider, object-storage and draw/KMS keys.
- Keep key-version metadata and test rotation/rollback. Changing `SESSION_SECRET` invalidates existing session-token hashes and affects demo draw seed decryption.
- Prevent untrusted/fork CI from accessing deployment secrets.
- Never expose secrets through `NEXT_PUBLIC_*` or client bundles.

## Secure change requirements

For security-, money-, entry- or draw-sensitive work:

- read the installed Next.js 16 documentation in `node_modules/next/dist/docs/`;
- validate input and reauthorize inside the final server boundary;
- resolve tenant from trusted server/provider context, not caller-supplied IDs;
- load money, rule and state authorities inside the transaction;
- use integer money and `bigint` entries;
- define idempotency and reject conflicting reuse;
- append compensating ledger records instead of editing grants;
- preserve provider/configuration/rules/calculation versions and fingerprints;
- audit actor, reason and correlation identity without leaking personal data;
- test concurrency, cross-tenant denial, lifecycle boundaries, cap behavior and replay conflict;
- test desktop/mobile/keyboard/accessibility when participant UX changes.

Run at minimum:

```bash
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
npm run test:e2e
npm audit --audit-level=high
```

## Production launch checklist

- Demo mode, routes, data, users, secrets and provider IDs are absent or unreachable.
- PostgreSQL migrations/invariants/roles and restore procedure pass independent review.
- Live Stripe signature/mode/version, capture/refund/subscription/reconciliation and failure tests pass.
- Tax, fulfillment/tracking/returns and dispute/chargeback adapters are operational.
- Resend domain, bounce/complaint/suppression and maintenance scheduler are monitored.
- Staff MFA/SSO, least privilege, step-up and dual-control policies are enforced.
- Rate limits/bot review protect AMOE and purchase without silently rejecting valid participants.
- TLS/HSTS/CSP/cookies/trusted host/proxy/cache behavior are verified at the edge.
- Logs are redacted and integrity/security alerts reach an accountable on-call owner during campaigns.
- Rules/campaign checksum, approvals, filing/bond receipts, prize funding and accessibility evidence are complete.
- Paid/AMOE parity, provider/ledger reconciliation, snapshot, independent draw, winner claim and fulfillment tabletop exercises pass.
- Incident, outage-at-cutoff, extension/cancellation, breach, provider replay and disaster-recovery runbooks have named decision-makers.
