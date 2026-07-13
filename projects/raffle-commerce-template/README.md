# Giveaway storefront template

A brand-overlayable commerce and promotion platform built with Next.js 16. It provides the public surface people expect from a modern giveaway brand—campaign landing pages, countdowns, products, cart, hosted checkout, memberships, no-purchase entry, accounts, winners, help and policies—plus the less-visible accounting and operator controls needed to administer a sweepstakes consistently.

The included **Northstar Supply** tenant, artwork, catalog, campaign, entries, approvals, filings and winners are fictional. The project recreates general system patterns, not another company's proprietary code, content, data or assets.

This is an engineering foundation, not a substitute for a promotion administrator or legal advice. It is designed for a **sweepstakes/giveaway** model with a free method of entry. Do not relabel or operate it as a paid raffle or lottery without specific legal authorization for the operator, jurisdiction and structure.

## What works

### Participant experience

- Responsive campaign-first home page with an announcement bar, countdown, current entry offer, prize details and exact Official Rules link.
- Searchable shop, collections, product variants, inventory-aware cart, quick-entry products and physical/digital merchandise.
- Server-authoritative demo checkout or Stripe-hosted Checkout, with idempotent capture settlement from signed webhooks.
- Direct online alternative method of entry (AMOE), separate cutoffs, eligibility attestations, receipts and a staff review path.
- Recurring membership plans with Stripe Checkout, Billing Portal, tenure entry bands, renewal settlement and cancellation-at-period-end.
- Customer registration, email verification, login, password reset, profile/session controls, order history, subscriptions and a combined entry ledger.
- Verified guest-order/entry claim flow that never silently merges ambiguous identities.
- Winners archive, provisional-candidate workflow, verification deadlines, publication consent, fulfillment evidence and scam guidance.
- Versioned privacy, terms, returns and Official Rules pages; help center and support intake.

### Integrity and operations

- Tenant-scoped campaign, catalog, legal, theme, entrant, commerce, subscription, support, audit and draw data.
- Exact immutable Campaign → Official Rules relation and checksum; every entry acceptance records the governing document.
- One append-only entry ledger for purchase, AMOE, membership, reversal and controlled post-freeze adjustment events.
- Deterministic integer money/entry calculations, shared per-entrant cap and authoritative targeted/time-bounded entry rules.
- Persisted canonical campaign release manifest/checksum binding ordinary catalog and membership transaction facts, plus two-person publication approvals, operational evidence and filing-requirement records.
- Inventory reservation, idempotency, provider-event claiming, replay/conflict detection and explicit refund allocation.
- Signed Stripe webhook intake for one-time checkout, subscription invoices/state and refunds.
- Resend-backed transactional outbox with bounded leases, retry state, stale-event cancellation and current-state rendering.
- Rate limits for high-risk public/authentication flows and bounded maintenance cleanup.
- Canonical entry snapshots, checksums, two-person sealing, deterministic internal demo draw, ordered alternates and audit history.
- Controlled adjustments for refunds or paid renewals discovered after a snapshot freezes, including pre-draw rebuild rules and post-draw disqualification safeguards.
- Staff views and actions for AMOE review, support, refunds, adjustments, snapshot/draw operations, candidates and winner fulfillment.
- Public JSON endpoints, health/readiness routes, unit/integration/browser suites and automated accessibility checks.

## Start locally

Prerequisites: Node.js 20.9+ (Node 22 is used in CI) and npm.

```bash
cp .env.example .env
npm install
npm run db:setup
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The example `DATABASE_URL` creates `prisma/dev.db`; `DEMO_MODE=true` keeps payments and email self-contained.

Seeded accounts:

| Role | Email | Password |
| --- | --- | --- |
| Sponsor administrator | `admin@example.com` | `DemoAdmin!234` |
| Compliance witness | `witness@example.com` | `DemoWitness!234` |
| Customer | `alex@example.com` | `DemoCustomer!234` |

Never expose the demo database or reuse its credentials/secrets. `npm run db:reset` is destructive and intended only for disposable local data.

Useful routes:

- `/` — campaign storefront
- `/giveaways/adventure-rig` — campaign and prize detail
- `/giveaways/adventure-rig/free-entry` — direct no-purchase entry
- `/shop`, `/collections/quick-entry`, `/cart`, `/checkout` — catalog and commerce
- `/membership` — recurring plan enrollment
- `/account` — customer history and controls
- `/winners`, `/help`, `/policies` — trust, support intake and service content
- `/admin` — role-protected operations console
- `/api/health/live`, `/api/health/ready` — process and deployment readiness
- `/api/v1/public/campaigns`, `/api/v1/public/catalog` — tenant public summaries
- `/api/internal/maintenance` — bearer-authenticated bounded maintenance pass
- `/api/webhooks/stripe` — raw-body signed Stripe webhook endpoint

## Verification and database commands

| Command | Purpose |
| --- | --- |
| `npm run lint` | ESLint with zero warnings |
| `npm run typecheck` | Next/TypeScript contract check |
| `npm test` | Unit and service tests |
| `npm run test:integration` | Disposable-database integration suite |
| `npm run test:e2e` | Disposable desktop/mobile Playwright suite |
| `npm run build` | Production webpack build |
| `npm run validate:examples` | Validate every checked-in tenant/theme/brand/catalog/legal/campaign contract |
| `npm run verify` | Lint, typecheck, example contracts, unit/integration tests and build |
| `npm run verify:full` | `verify`, disposable browser suite and dependency audit |
| `npm audit --audit-level=high` | Dependency vulnerability gate used by CI |
| `npm run db:generate` | Generate Prisma Client |
| `npm run db:push` | Push the schema to a local database |
| `npm run db:seed` | Load fictional demo data |
| `npm run db:harden` | Install SQLite demo immutability triggers |
| `npm run db:setup` | Generate, push, seed and harden |
| `npm run db:reset` | Destructively recreate, seed and harden |
| `npm run staff:list -- --tenant northstar` | Read active staff IDs used by release commands |
| `npm run tenant:validate -- config/tenant.example.json` | Validate a non-secret tenant/staff bootstrap manifest |
| `npm run tenant:plan -- config/tenant.example.json` | Inspect bootstrap collisions without writing |
| `npm run tenant:bootstrap -- config/tenant.example.json --confirm` | Create a tenant and first ADMIN/COMPLIANCE users from reviewed mailbox proof plus environment-supplied passwords |
| `npm run catalog:validate -- config/catalog.example.json` | Validate an initial catalog manifest without a database |
| `npm run catalog:plan -- config/catalog.example.json` | Check tenant currency and catalog identity collisions without writing |
| `npm run catalog:apply -- config/catalog.example.json --actor <admin-id> --confirm` | Atomically create an initial product/variant/collection/plan bundle |

`db:push` is a local convenience. A production database needs reviewed, checked-in migrations and a controlled deploy/rollback procedure.

## Rebrand and publish a campaign

There are six distinct setup/release surfaces. Keeping them separate makes review and rollback understandable:

1. **Tenant bootstrap:** isolated tenant plus distinct ADMIN and COMPLIANCE users whose external mailbox-proof references are archived; passwords never belong in the JSON manifest.
2. **Brand bundle:** tenant identity, shipping settings and theme.
3. **Catalog import:** a checksummed, create-only initial set of products, active variants, collections and membership plans.
4. **Legal release:** immutable, versioned policy and Official Rules documents.
5. **Campaign release:** exact rules checksum, windows, prize, eligibility, entry rules, multiplier schedule, membership bands, approvals and filings.
6. **Runtime:** owned assets, Stripe, Resend, maintenance, database, tax, fulfillment, draw custody and monitoring.

Start with the checked-in examples:

```bash
npm run tenant:validate -- config/tenant.example.json
npm run tenant:plan -- config/tenant.example.json
# Inject two distinct strong passwords from a secret manager, without placing
# their values in the command or shell history, then:
npm run tenant:bootstrap -- config/tenant.example.json --confirm
unset BOOTSTRAP_ADMIN_PASSWORD BOOTSTRAP_COMPLIANCE_PASSWORD
npm run staff:list -- --tenant <new-tenant-slug>

npm run theme:validate -- config/theme.example.json
npm run brand:validate -- config/brand.example.json
npm run brand:plan -- config/brand.example.json
npm run catalog:validate -- config/catalog.example.json
npm run catalog:plan -- config/catalog.example.json
npm run legal:validate -- config/legal.example.json
npm run legal:plan -- config/legal.example.json
npm run campaign:validate -- config/campaign.example.json
npm run campaign:plan -- config/campaign.example.json
```

Copy every example to a company-specific file and make all `targetTenantSlug` values match the bootstrapped slug before planning. Publishing/applying is intentionally explicit and requires active role-separated staff identities. `staff:list` returns the IDs accepted by `--actor` and `--witness`. Review each dry-run before passing its confirmation flag. The catalog importer is deliberately create-only: any slug, SKU, collection or recurring Price collision blocks the whole transaction, so subsequent catalog lifecycle changes need a separately reviewed mutation workflow.

Copy the `OFFICIAL_RULES vN` **body checksum** printed by `legal:validate` into the campaign file—not the overall legal release checksum. The all-zero checksum in `config/campaign.example.json` is an intentional placeholder: validation succeeds, the plan prints `publishReady: false`, and publication is blocked until it is replaced. A campaign cannot publish unless the exact Official Rules version/checksum already exists, its release is effective by campaign start, its catalog targets/evidence are complete and no live/scheduled entry window collides.

For a durable theme-only update, use the validated `ThemeVersion` publisher. For a complete company overlay, use the brand release contract and replace every demo image under `public/demo` with optimized, licensed assets. See [Customization](docs/customization.md).

## Production boundary

Several production adapters are implemented, but the repository deliberately refuses to claim that configuration alone makes a lawful, launch-ready promotion.

| Area | Shipped foundation | Operator work before launch |
| --- | --- | --- |
| Payments | Stripe hosted one-time and recurring Checkout, Billing Portal, pinned-version signed webhooks, capture/refund idempotency | Live account/config review, tax treatment, reconciliation/alerts, dispute/chargeback policy and sandbox-to-live certification |
| Refunds | Provider refund initiation/settlement, explicit allocation, ledger reversal and post-freeze adjustment workflow | Staff policy/permissions, provider reconciliation and chargeback/dispute event mapping |
| Email | Resend adapter, verified-sender configuration, durable outbox, bounded retry worker | Domain authentication, bounce/complaint/suppression handling, monitoring and deliverability runbook |
| Database | Prisma schema and hardened SQLite demo | PostgreSQL migrations/constraints, least-privilege roles, backup/PITR, restore tests and production concurrency testing |
| Jobs | Authenticated idempotent maintenance endpoint | External scheduler/queue, overlap prevention, alerting, dead letters and operational ownership |
| Tax/fulfillment | Explicit order allocation and fulfillment evidence model | Real tax engine, warehouse/3PL adapter, shipping/tracking reconciliation and returns operations |
| Draw | Checksummed snapshots, dual seal and auditable internal demo selection | Counsel-approved procedure and preferably independent administrator/custody/KMS evidence |
| Staff security | Hashed sessions, roles, action reauthorization, dual-control workflows | Enforced MFA/passkeys/SSO, step-up controls, finer capabilities and access reviews |
| Legal/filings | Versioned releases, checksums, evidence and filing tasks | Promotion counsel, sponsor/prize substantiation, jurisdiction matrix, registrations/bonds, tax/privacy/accessibility review |
| Winner claims | Candidate/deadline/disposition/publication/fulfillment state machine | Secure identity/tax-document portal, restricted storage and verified contact procedure |

In production, `/api/health/ready` remains fail-closed for the unshipped tax/fulfillment and staff-MFA/independent-draw gates. Replace those static gates only with real adapter/assurance health checks.

## Documentation

- [Reference parity](docs/reference-parity.md) — public surface benchmark and deliberate non-copies
- [Architecture](docs/architecture.md) — trust boundaries, state and accounting flows
- [Customization](docs/customization.md) — tenant/brand/catalog/legal/campaign overlay contracts
- [Operations](docs/operations.md) — launch, maintenance, reconciliation, draw, winner and incident runbooks
- [Deployment](docs/deployment.md) — environment, providers and production migration
- [Compliance](docs/compliance.md) — counsel handoff and jurisdiction review map
- [Security](SECURITY.md) — implemented controls, remaining risks and launch checklist

## License and provenance

No project license is included. Choose and add one before redistribution. All demo copy and artwork are placeholders created for this template; replace them before publishing a company brand.
