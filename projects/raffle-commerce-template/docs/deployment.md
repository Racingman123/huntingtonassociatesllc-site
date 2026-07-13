# Production deployment

The repository is a zero-service SQLite demonstration by default, but it also includes real Stripe hosted checkout/subscription/refund boundaries, a signed Stripe webhook processor, Resend transactional email delivery, account recovery, and a bounded maintenance endpoint. Those adapters are usable foundations; they do not make the repository production-ready by changing environment variables alone.

## Shipped production boundaries and launch gaps

Implemented application paths include:

- server-authoritative one-time checkout preparation and Stripe Checkout creation;
- Stripe subscription Checkout, Billing Portal handoff, paid/failing invoice settlement, and subscription-state updates;
- an authorized refund intent with explicit merchandise/shipping/tax allocation, provider refund creation, and signed refund settlement;
- idempotent, payload-hashed Stripe webhook claims;
- Resend transactional messages from a leased/retrying outbox worker;
- email verification, password recovery, session revocation, and safe guest-history claim review;
- scheduled campaign activation, checkout reservation cleanup, subscription cancellation, and bounded data cleanup through maintenance;
- pre/post-freeze entry-adjustment controls for refunds and late paid renewals.

The following production work is intentionally not shipped:

- reviewed PostgreSQL migrations, roles, and equivalents for every SQLite hardening trigger;
- an authoritative sales-tax engine and fulfillment/digital-delivery consumer;
- Stripe dispute/chargeback event mapping and independent settlement reconciliation;
- Resend delivery-event verification, bounce/complaint suppression, and a marketing preference center;
- staff MFA/SSO, step-up authentication, and formal staff provisioning/deprovisioning;
- an independent draw administrator and immutable external evidence custody.

`/admin/configuration` and `/api/health/ready` deliberately remain action-required in production for tax/fulfillment and staff-MFA/independent-draw assurance. Do not remove those gates until they are replaced with verifiable adapter and control health checks.

## Non-negotiable launch gates

Before enabling real traffic:

- set `DEMO_MODE=false` and confirm every demo-only mutation is unreachable;
- deploy reviewed PostgreSQL migrations and least-privilege roles;
- configure Stripe keys, pinned API version, endpoint signing secret, correct livemode, product Prices, and sandbox/live reconciliation;
- integrate tax, shipping/fulfillment, inventory exceptions, digital delivery, and returns;
- map disputes/chargebacks and define their entry effect in the exact Official Rules;
- schedule and monitor maintenance, including email/outbox age and dead letters;
- configure a verified Resend sender plus bounce/complaint/suppression handling;
- enforce staff MFA/SSO and separation of administrator/compliance duties;
- export checksummed release/snapshot/draw evidence to immutable storage and use the approved independent draw administrator;
- complete backups, restore testing, telemetry, alerting, incident response, filing/bond evidence, and counsel approval for the exact legal/campaign checksums.

## Environment isolation

Maintain separate development, test, staging, and production environments with separate databases, Stripe/Resend accounts or modes, secrets, domains, staff identities, storage, telemetry, and alert routing. Never copy production entrant, payment, support, recovery, or winner data into development. Staging should reproduce production topology with generated fixtures and provider sandbox data.

## Environment variables

Use `.env.example` as the source list and validate configuration at startup/deploy time. Current variables are:

| Variable | Purpose | Production requirement |
| --- | --- | --- |
| `DATABASE_URL` | Prisma connection | TLS PostgreSQL URL for a restricted runtime role after the migration work below |
| `DEPLOYMENT_ENV` | Readiness profile: `development`, `staging`, or `production` | Set explicitly; omission under `NODE_ENV=production` fails safe to `production` |
| `SESSION_SECRET` | Session/challenge cryptographic key material | Non-placeholder secret of at least 32 characters from a secret manager |
| `RATE_LIMIT_SECRET` | HMAC for anonymous abuse-control identifiers | Independent high-entropy secret; fallback to `SESSION_SECRET` is suitable only for local use |
| `APP_URL` | Canonical links and Stripe return URLs | Exact absolute HTTPS origin |
| `DEMO_MODE` | Enables synthetic checkout/automatic demo operations | `false` |
| `DEFAULT_TENANT_SLUG` | Local/canonical-host tenant fallback | Active tenant for this deployment |
| `BOOTSTRAP_ADMIN_PASSWORD` | One-shot initial ADMIN credential read only by `tenant:bootstrap` | Inject from a secret manager for bootstrap, then unset; never persist in JSON, source control, CI, logs, or a committed `.env` |
| `BOOTSTRAP_COMPLIANCE_PASSWORD` | Distinct one-shot initial COMPLIANCE credential | Same handling as the admin password; rotate both into the production identity system before launch |
| `TRUST_PROXY_HEADERS` | Enables forwarded-host/client IP interpretation | `true` only behind a proxy that strips spoofed forwarding headers |
| `CRON_SECRET` | Bearer authentication for maintenance | Independent non-placeholder secret of at least 32 characters, different from `SESSION_SECRET` |
| `STRIPE_SECRET_KEY` | Server Stripe API access | Secret-manager value for the correct account/mode |
| `STRIPE_WEBHOOK_SECRET` | `/api/webhooks/stripe` signature verification | Endpoint-specific signing secret |
| `STRIPE_WEBHOOK_API_VERSION` | Envelope/version pin | Exactly the installed Stripe SDK API version |
| `STRIPE_WEBHOOK_LIVEMODE` | Rejects events from the wrong mode | `true` for `DEPLOYMENT_ENV=production`; `false` for staging/test |
| `STRIPE_MEMBERSHIP_PRICE_ID` | Optional local demo-seed plan binding | Do not seed production; the reviewed catalog import writes each `SubscriptionPlan.providerPriceId` directly |
| `EMAIL_FROM` | Transactional sender | Provider-verified, non-example sender |
| `RESEND_API_KEY` | Resend API authentication | Secret-manager value scoped to the production account/domain |

Additional production integrations need their own validated configuration: migration/direct database URLs, tax/fulfillment credentials, queues, object storage/KMS, independent draw service, telemetry, and trusted proxy/network policy.

Never expose server credentials via `NEXT_PUBLIC_*`, browser bundles, redirects, logs, error pages, outbox payloads, or checked-in files. Prefer workload identity or short-lived credentials where the provider supports them.

## Publish the release, do not seed it

Do not run `db:seed` or `db:reset` in production. Bootstrap into an empty reviewed database, create the initial catalog with the collision-blocking importer, then publish checksummed/versioned release configuration in this order:

```bash
npm run tenant:validate -- config/acme-tenant.json
npm run tenant:plan -- config/acme-tenant.json
# Inject both distinct values from the deployment secret manager, then:
npm run tenant:bootstrap -- config/acme-tenant.json --confirm
unset BOOTSTRAP_ADMIN_PASSWORD BOOTSTRAP_COMPLIANCE_PASSWORD
npm run staff:list -- --tenant acme

npm run brand:validate -- config/acme-brand.json
npm run brand:plan -- config/acme-brand.json
npm run brand:apply -- config/acme-brand.json --actor <admin-id> --confirm

npm run catalog:validate -- config/acme-catalog.json
npm run catalog:plan -- config/acme-catalog.json
npm run catalog:apply -- config/acme-catalog.json --actor <admin-id> --confirm

npm run legal:validate -- config/acme-legal-v1.json
npm run legal:plan -- config/acme-legal-v1.json
npm run legal:publish -- config/acme-legal-v1.json \
  --actor <admin-id> --witness <compliance-id> --confirm

npm run campaign:validate -- config/acme-campaign.json
npm run campaign:plan -- config/acme-campaign.json
npm run campaign:publish -- config/acme-campaign.json \
  --actor <admin-id> --witness <compliance-id> --confirm
```

Make every manifest's tenant slug refer to the same bootstrapped tenant. Verify both privileged mailboxes out of band and put only distinct opaque evidence-system references/timestamps in the tenant manifest; bootstrap treats those attestations as the basis for `emailVerifiedAt` and archives them in its audit record. The catalog tool is deliberately create-only: it atomically creates new identities and refuses collisions; use a separately designed lifecycle workflow for later catalog mutations. Archive the source JSON, code revision, plan output, bootstrap/catalog/release checksums, actor/witness identities, and external legal/filing evidence. The campaign publisher refuses a rules checksum/version that does not identify the exact published Official Rules effective by campaign start.

## PostgreSQL migration

SQLite and `prisma/sql/sqlite-hardening.sql` are local-demo mechanisms. No reviewed PostgreSQL migration set is shipped.

Create the production baseline in a dedicated branch and disposable PostgreSQL environment:

1. Provision a supported PostgreSQL release with TLS, encryption, automated backups, and point-in-time recovery.
2. Create separate owner/migration, runtime, and read-only support roles. The runtime role must not alter schema, disable triggers, or update protected records.
3. Change the Prisma datasource provider and configure runtime/direct migration URLs for the selected pooler/topology.
4. Generate and review checked-in Prisma migrations against a disposable database.
5. Reimplement every SQLite trigger/invariant in PostgreSQL SQL and test it with the runtime role.
6. Apply migrations to a second empty database using the same `prisma migrate deploy` step CI/CD will use.
7. Run integration, concurrency, failure-injection, browser, reconciliation, backup, and restore tests against production-shaped synthetic data.
8. Obtain database/security review of SQL, grants, query plans, lock behavior, and rollback strategy.

Never use `prisma db push`, `db:harden`, `db:setup`, or `db:reset` in production.

At minimum, enforce immutable ledger/audit/sealed snapshot/published legal records, nonzero ledger deltas, nonnegative account projections, tenant consistency, unique provider/idempotency identities, exact campaign-rules relations, valid snapshot range partitions, and protected post-freeze adjustment transitions. Review serialization and retry behavior for cap allocation, inventory reservation/capture, webhook settlement, subscription cycles, refunds, snapshot rebuilds, and winner state.

## Stripe checkout and webhooks

### Endpoint configuration

Configure Stripe to send these events to `POST /api/webhooks/stripe`:

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

The endpoint is disabled in demo mode. It reads a bounded raw body, verifies the Stripe signature, requires the pinned API version and configured livemode, validates the repository's versioned metadata contracts, hashes the payload, and claims a unique provider event before domain processing. A duplicate identical delivery is idempotent; a conflicting identity/payload fails closed.

Processing is synchronous inside the request after the durable database claim. Failed processing is recorded and returns a non-success status for Stripe retry. This is not a general durable job queue and does not replace independent provider reconciliation or alerting on failed/in-progress webhook records.

### One-time checkout

Production checkout recomputes the cart, targeted entry rules, scheduled multiplier, exact Official Rules, eligibility, shipping, and inventory on the server. It creates a pending Stripe order/reservation and hosted Checkout Session with a stable fingerprint/metadata contract. The browser success return is receipt navigation only.

Only a verified paid Checkout event settles payment, consumes inventory, records rules acceptance, creates eligible line entitlements/ledger entries, and queues receipt/fulfillment intent. Settlement rechecks current campaign-entrant eligibility: a disqualification committed after Checkout preparation preserves captured money, inventory and the order but withholds promotional entries with explicit audit evidence. Checkout expiry or asynchronous failure releases the reservation through the event path or maintenance cleanup. Reconcile abandoned/stuck sessions with Stripe independently.

### Subscriptions

Membership enrollment creates a Stripe subscription Checkout Session for a plan whose local amount, currency, interval, and provider Price match. The Billing Portal handles customer self-service. Checkout binds provider subscription/customer identity; `invoice.paid` and `invoice_payment.paid` normalize to one invoice settlement identity, and subscription/failure events update local state.

A subscription grant occurs only for a verified paid invoice whose immutable subscription fingerprint matches the release-bound plan, whose campaign manifest is intact, whose entrant accepted that campaign's exact Official Rules, and whose current eligibility passes. If any gate or eligible campaign/band is absent, the paid cycle and payment are still recorded with reasoned zero promotional entries. If an eligible paid invoice arrives after snapshot freeze, monetary/cycle truth is preserved and any positive entry delta is routed to a reviewed adjustment rather than being silently discarded or inserted into a sealed ledger.

### Refund initiation and settlement

Authorized staff create a canonical refund intent with an explicit allocation across merchandise lines, shipping, and tax. For Stripe orders, the provider adapter sends a versioned `order-refund-v1` metadata contract and stable idempotency key, then stores the provider refund identity. A matching signed `refund.created`/`refund.updated` event with succeeded status is authoritative for local monetary settlement and entry reversal. Terminal `refund.updated` or `refund.failed` events mark the local intent failed, preserve provider evidence, release its allocation for a newly authorized retry, and never alter captured order money.

Before snapshot freeze, completed refund reversals post normally. After freeze, the payment/refund remains truthful while the entry effect becomes a relational adjustment requiring distinct operations and compliance approvals. Before a published draw, approved adjustments void/reverse the affected snapshot and require rebuild/reseal. After draw publication, the snapshot remains preserved and the entrant/candidate is disqualified or fulfillment is blocked according to the reviewed workflow. Monitor unresolved adjustments; do not bypass them with direct ledger edits.

### Disputes and reconciliation gap

Stripe dispute, chargeback, and won-dispute events are not mapped. Unsupported event types are ignored by the normalizer. Build explicit, idempotent mappings, exact rules policy, staff review/appeal behavior, entry adjustment consequences, and reconciliation before launch. Also run scheduled Stripe-to-database reconciliation independent of webhook delivery for Checkout Sessions, PaymentIntents, invoices, subscriptions, refunds, disputes, amounts, currencies, and statuses.

## Resend, recovery, and the email outbox

When `RESEND_API_KEY` and a valid `EMAIL_FROM` are configured, maintenance processes a bounded batch of supported transactional email outbox kinds. The worker uses compare-and-update leases, provider idempotency keys, current-state template rendering, exponential retry, and dead-letters after five failed attempts. The maintenance pass deliberately caps email delivery at three candidates.

Supported messages include order/free-entry/refund lifecycle notices and account email-verification/password-recovery challenges. Challenge links are one-hour, single-use bearer capabilities; only an HMAC digest is stored, password reset revokes all sessions, and ambiguous guest history claims route to review.

Still required for production email operations:

- Resend webhook signature verification and delivery-event storage;
- hard/soft bounce and complaint classification;
- tenant-wide suppression and provider reconciliation;
- unsubscribe/preference center and downstream marketing propagation;
- sender-domain monitoring, template review, deliverability dashboards, and dead-letter ownership.

Do not mark provider acceptance as inbox delivery. Never include passwords, payment secrets, raw claim evidence, or unnecessary personal data in email/outbox payloads.

## Schedule maintenance

Call `POST /api/internal/maintenance` from an authenticated external scheduler using:

```http
Authorization: Bearer <CRON_SECRET>
```

Each pass is bounded and idempotent. It currently:

- closes ended live purchase windows and activates eligible scheduled campaigns;
- finalizes due subscription cancellations;
- revokes expired sessions;
- prunes expired rate-limit buckets and consumed/expired account challenges;
- releases expired Stripe Checkout reservations outside demo mode;
- delivers up to three due transactional emails when Resend is configured;
- reports pending outbox and AMOE-review counts.

The route returns `207` when a bounded subtask reports failures and `500` if the pass itself fails. Alert on both, plus campaign activation failures, cancellation failures, checkout cleanup failures, retried/dead-lettered email, oldest pending age, and repeated lease conflicts.

Choose a schedule comfortably shorter than checkout reservation and operational SLA boundaries; once per minute is a practical starting point. Prevent overlapping invocations at the scheduler level even though individual handlers use compare-and-update guards. Non-email fulfillment outbox events require their own consumer.

## Tax and fulfillment

The shipped quote records zero tax. Physical settlement writes fulfillment intent but no carrier/warehouse consumer is included; digital products likewise need a real delivery path. Production must provide:

- destination validation and authoritative tax quotes captured at payment time;
- exemption, inclusive/exclusive display, rounding, refund, and filing behavior;
- idempotent warehouse/carrier/digital-delivery consumption;
- inventory reservation, partial fulfillment, cancellation, return, oversell, and failure handling;
- provider reconciliation and customer-visible status/tracking sourced from real provider truth.

Keep merchandise/shipping/tax allocation explicit so refunds never reverse entries for shipping- or tax-only amounts.

## Staff authentication and authorization

Customer and staff sessions are password-based. Role and tenant checks exist, but MFA/SSO and step-up authentication do not. Before production:

- integrate the approved identity provider and enforce phishing-resistant MFA for staff;
- restrict staff routes at the network/identity layer as defense in depth;
- require step-up for release publishing, refunds, adjustments, snapshot sealing, draw, winner verification, and publication;
- implement joiner/mover/leaver, recovery, emergency-access, access-review, and session-revocation procedures;
- preserve distinct human administrator/compliance/operations duties.

## Snapshot, draw, and evidence custody

The application can build and checksum entry snapshots, collect approvals, run an internal demo draw, and administer candidates/winners. `DEMO_MODE=false` blocks the internal draw. Production needs an approved independent administrator integration and immutable storage with versioning, encryption/KMS, retention lock where appropriate, access logs, and restricted roles.

Export the canonical campaign/legal release bundle, filing evidence, snapshot rows/checksum, adjustment decisions, approval evidence, draw request/result/certificate, and winner decisions. Verify signed results against the submitted snapshot checksum and import them through a reviewed custody workflow. Do not use a mutable database blob as the sole evidence copy.

## Build and release pipeline

A minimum immutable pipeline should:

1. install from the lockfile with `npm ci` and scan secrets/dependencies;
2. run `npm run verify` (lint, typecheck, unit tests, disposable integration tests, and production build);
3. run `npm run verify:full` where browser/network access is available (adds Playwright and high-severity audit gating);
4. test against disposable PostgreSQL plus Stripe/Resend sandbox fixtures;
5. generate an SBOM and sign the image/artifact;
6. apply `prisma migrate deploy` with the migration role in a separately authorized step;
7. deploy immutable web and worker/scheduler configuration with the runtime role;
8. publish or verify the intended tenant/catalog/brand/legal/campaign checksums;
9. run health, reconciliation, outbox, recovery, and storefront/AMOE smoke tests;
10. record revision, dependency lock, migration, provider configuration, release checksums, approvers, and deployment result.

Do not seed during startup and do not give the web process schema-owner credentials.

## Runtime security and observability

The app sets CSP, referrer, frame, content-type, permissions, and related headers. At the edge, enforce HTTPS/HSTS after confirming coverage, trusted host/proxy policy, request/body/time limits, rate/bot controls, no-store behavior for sensitive routes, and a CSP restricted to actual providers.

Emit structured, redacted events with environment, tenant, correlation ID, safe resource ID, idempotency hash, result, and duration. Never log session cookies, authorization headers, provider secrets/signatures, passwords/hashes, raw recovery tokens, full addresses, claim/tax documents, unrestricted webhook bodies, entrant exports, or draw seeds/evidence.

At minimum, alert on:

- readiness/action-required changes and database errors;
- Stripe webhook failure, duplicate/conflict patterns, and reconciliation differences;
- payment/order/refund/subscription amount or state mismatches;
- ledger/account/snapshot differences and unresolved post-freeze adjustments;
- AMOE review age, recovery abuse, authentication/rate-limit spikes;
- outbox age, retries, dead letters, bounce/complaint/suppression anomalies;
- scheduled campaign activation and subscription cancellation failures;
- backup/PITR health, restore-test age, and independent draw/evidence import failures.

## Backup, recovery, and rollback

Enable encrypted PostgreSQL PITR and immutable/cross-account backups. Back up object evidence, release bundles, provider/account mapping, and KMS metadata. Regularly restore into an isolated environment and verify migrations/roles, ledger projections, payments/refunds/cycles, outbox/webhook claims, snapshot checksums, provider reconciliation, and recovery time.

Use backward-compatible expand/migrate/contract changes. For a failed release, suspend affected mutations/campaigns, keep accepting provider inputs safely, preserve failed webhook/outbox records for replay, roll back only to schema-compatible code, and reconcile money/entries before resuming. Never overwrite newer valid payment or ledger events with a casual database restore.

## Production smoke test

- `/api/health/live` returns 200; readiness has no unresolved required gate.
- Canonical and unknown-host behavior resolves/fails as designed; cookies are secure.
- Home, product, membership, exact Official Rules, AMOE, account, recovery, and policies contain no demo content.
- A Stripe sandbox one-time payment grants no entries before webhook and settles exactly once after capture; replay is idempotent.
- Subscription enrollment grants only on a paid invoice, records zero when no band/campaign applies, and exercises a late post-freeze invoice.
- An authorized partial refund preserves explicit line/shipping/tax allocation and exercises normal and post-freeze entry effects.
- An AMOE submission follows the real pending/review/receipt path without marketing consent.
- Verification/reset challenges expire, are single-use, revoke sessions where expected, and do not leak account existence.
- Resend acceptance, retry, dead-letter alert, delivery event, bounce, complaint, and suppression paths work.
- Tax, fulfillment/digital delivery, inventory release, tracking, and provider reconciliation work end to end.
- Staff MFA/SSO, tenant isolation, role separation, and step-up controls are verified.
- Snapshot export, immutable custody, independent draw result import, candidate deadline, and winner fulfillment block are verified.
- Backup, PITR, restore-test, telemetry, and on-call dashboards are green.

Enable traffic only after these checks and counsel/operations approval of the exact checksummed release.
