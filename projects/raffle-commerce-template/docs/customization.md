# Customization guide

This template separates brand presentation, immutable legal releases, campaign accounting, catalog data, and provider operations. Treat an overlay as a reviewed release, not a search-and-replace exercise.

The shipped promotion model is a sweepstakes/giveaway with a genuine free alternative method of entry (AMOE). Do not relabel it as a raffle or lottery, or sell entries directly, without qualified counsel and a purpose-built licensed workflow.

## Release order

Use this sequence for a new company or promotion:

1. Bootstrap an isolated tenant and staff identities.
2. Apply the tenant identity, shipping settings, and first theme with the brand CLI.
3. Replace demo assets, copy, catalog, variants, collections, and membership plans.
4. Publish counsel-approved legal documents with the legal CLI.
5. Put the exact published Official Rules version and body checksum in the campaign overlay.
6. Validate and plan the campaign, then publish it with distinct administrator and compliance identities.
7. Exercise purchase, subscription, AMOE, refund, recovery, snapshot, draw, and winner flows in a disposable environment.
8. Complete the production gates in [Deployment](deployment.md) before accepting real entries or money.

`config/tenant.example.json`, `config/theme.example.json`, `config/brand.example.json`, `config/catalog.example.json`, `config/legal.example.json`, and `config/campaign.example.json` are executable examples. Copy them to company-specific, version-controlled release files, align every target tenant slug, and never turn the examples themselves into an unreviewed production payload.

## Release CLIs

The repository includes controlled bootstrap, import, and publication tools. Validation is useful without a database; plan/apply/publish commands inspect the target database and therefore require `DATABASE_URL` and generated Prisma client code.

### Tenant and first staff

The tenant manifest contains company identity and two distinct staff email addresses, but never passwords:

```bash
npm run tenant:validate -- config/acme-tenant.json
npm run tenant:plan -- config/acme-tenant.json
# Inject both distinct values from a secret manager without putting either
# value in the command or shell history, then:
npm run tenant:bootstrap -- config/acme-tenant.json --confirm
unset BOOTSTRAP_ADMIN_PASSWORD BOOTSTRAP_COMPLIANCE_PASSWORD
```

`tenant:plan` is read-only and reports case-insensitive slug, primary-domain, and privileged-email collisions. Each staff record must also contain a distinct reviewed mailbox-ownership evidence reference and the time that proof was verified; the bootstrap audit archives both. Do not put private evidence content or bearer URLs in the manifest—use an opaque identifier into a restricted evidence system.

Bootstrap rechecks inside a serializable transaction, requires two distinct non-placeholder passwords of at least 14 characters with upper/lowercase, number, and symbol and at most 72 UTF-8 bytes (bcrypt's safe input boundary), hashes them at bcrypt cost 12, creates active verified ADMIN and COMPLIANCE users, and records a checksum-bound audit event without logging either secret or hash. Supply the passwords from a secret manager or one-shot process environment and remove them immediately afterward; do not save them in `.env`, shell history, JSON, logs, CI variables, or source control. Bootstrap accepts only currencies with exactly two minor-unit digits because the commerce schema stores integral cents.

List the active staff IDs accepted by `--actor` and `--witness` without opening a database editor:

```bash
npm run staff:list -- --tenant acme
```

### Brand and theme

The brand bundle updates tenant-visible identity and shipping fields and publishes the theme in one transaction:

```bash
npm run brand:validate -- config/acme-brand.json
npm run brand:plan -- config/acme-brand.json
npm run brand:apply -- config/acme-brand.json \
  --actor <active-admin-user-id> --confirm
```

The actor must be an active `ADMIN` in the target tenant. The apply command records an audit event. If the theme checksum changed, it supersedes the prior published theme and creates the next tenant-local version.

For a theme-only release:

```bash
npm run theme:validate -- config/acme-theme.json
npm run theme:publish -- config/acme-theme.json \
  --tenant acme --name "Summer refresh" \
  --actor <active-admin-user-id> --confirm
```

Both validators enforce the schema and built-in WCAG AA text-pair contrast checks. They do not replace keyboard, screen-reader, zoom, responsive, or third-party checkout testing.

### Initial catalog

Import the first catalog only after the tenant exists and the brand's owned asset paths are ready:

```bash
npm run catalog:validate -- config/acme-catalog.json
npm run catalog:plan -- config/acme-catalog.json
npm run catalog:apply -- config/acme-catalog.json \
  --actor <active-admin-user-id> --confirm
```

The manifest covers products, one or more active variants per product, ordered collections, and an optional recurring plan on each membership product. Validation enforces integral nonnegative minor units/inventory, two-decimal currency, root-relative asset paths, unique case-insensitive SKUs, unique slugs and option combinations, collection referential integrity, physical product inventory equal to the sum of its variants at import, and product/plan price and currency parity. Runtime availability and admin stock totals are then derived from active variant on-hand minus reserved inventory; the duplicate product-level import aggregate is not an inventory authority. Plan checks the active tenant currency plus collisions with every existing tenant product slug, SKU, collection slug, and recurring provider Price. Apply rechecks those facts and the active ADMIN actor, creates the complete bundle atomically, and records its SHA-256 checksum and counts in the audit log.

This is a safe create-only initial importer, not a general catalog sync. A collision blocks the whole import and nothing is updated or deleted. Preserve stable identities once orders or released campaigns reference them. Design a separate, audited lifecycle workflow for later price, inventory, status, provider-Price, or merchandising changes; scheduled/live campaign integrity guards intentionally reject changes that would invalidate a bound entry-rule release.

### Legal release

Publish legal content before the campaign that references it:

```bash
npm run legal:validate -- config/acme-legal-v1.json
npm run legal:plan -- config/acme-legal-v1.json
npm run legal:publish -- config/acme-legal-v1.json \
  --actor <active-admin-user-id> \
  --witness <active-compliance-user-id> \
  --confirm
```

The actor and witness must be distinct active users in the same tenant. The publisher requires the next version for each document kind, computes a SHA-256 checksum from the exact stored body, publishes the rows atomically, and writes audit events containing the release checksum and compliance witness. Published legal rows are immutable under the local database hardening rules; correct a document by publishing another version.

Supported release kinds are `OFFICIAL_RULES`, `PRIVACY`, `TERMS`, `RETURNS`, `SUBSCRIPTION_TERMS`, `ACCESSIBILITY`, and `WINNER_LIST`. Official Rules validation also requires the no-purchase and purchase-does-not-increase-chances disclosures. Schema validation is a guardrail, not legal review.

### Campaign release

After the referenced Official Rules are published:

```bash
npm run campaign:validate -- config/acme-campaign.json
npm run campaign:plan -- config/acme-campaign.json
npm run campaign:publish -- config/acme-campaign.json \
  --actor <active-admin-user-id> \
  --witness <active-compliance-user-id> \
  --confirm
```

The plan checks tenant currency, campaign slug/code collisions, overlap with live or scheduled entry windows, timing, exact Official Rules version/body-checksum/effective date, referenced membership plans/currency, and active catalog entry-rule targets/coverage. Publish rechecks those facts in a serializable transaction and requires distinct active `ADMIN` and `COMPLIANCE` identities. It creates the campaign, prize, purchase and AMOE rules, multiplier schedule, membership bands, exact rules relation, publication/operational approvals and filing determination, then persists the canonical manifest containing those rows plus the active ordinary catalog and exact referenced membership plan/product/variant transaction facts. The manifest's SHA-256 becomes the campaign release checksum and is retained as immutable evidence.

`legal:validate` prints both a release checksum and one body checksum per document. Put the line labeled `OFFICIAL_RULES vN` in `campaign.officialRules.checksum`; do not use the overall release checksum. The zeros in `config/campaign.example.json` are a deliberate placeholder: structural validation succeeds, `campaign:plan` returns a successful dry-run with `publishReady: false`, and `campaign:publish` refuses the release until the real rules body exists.

Campaign membership bands reference an active membership product slug. Each plan's bands must start at zero settled cycles, be contiguous/non-overlapping, and end with one open-ended range. The publisher creates them atomically with the campaign.

`operationalApprovals` must contain exactly one evidence reference and substantive note for each built-in kind: `LEGAL_RULES`, `PRIZE_FUNDING`, `AMOE_PARITY`, `DRAW_PROCEDURE`, and `ACCESSIBILITY`. Publication attributes `PRIZE_FUNDING` to the admin actor and the other four to the compliance witness; the two publication approvals are additional records.

`filingDetermination` is one of:

- `REQUIREMENTS`, with unique jurisdiction/kind rows already `COMPLETED` or counsel-determined `NOT_APPLICABLE`, each carrying evidence and a completion time no later than campaign start; or
- `NO_FILINGS_REQUIRED`, with reviewed jurisdictions, a substantive counsel rationale, and evidence reference.

These are evidence records, not an automated legal conclusion. Extend the schema/publisher if a program needs more approval kinds or scheduled post-promotion filing tasks.

The shipped draw workflow supports exactly one prize with quantity one. The campaign validator rejects a different prize shape. Extend and independently review the snapshot, draw, alternate, and winner workflow before offering multiple prizes or quantities.

A future campaign becomes `SCHEDULED`; an already-open campaign becomes `LIVE`. Maintenance activates scheduled campaigns only after revalidating the bound configuration/rules checksums, current release-bound catalog/plan facts, the two exact publication approvals, timing, and absence of another live campaign. Scheduled/live SQLite guards block changes to those facts. After entry close, integrity compares campaign/evidence rows to the persisted manifest while using its historical catalog/plan section; that preserves a prior draw release while allowing preparation for the next promotion. The operational and filing evidence is created during publication; maintenance does not perform a new legal review. Do not update released campaign rows manually.

## Tenant identity and request routing

`Tenant` is the durable company boundary. Configure:

- stable `slug`;
- public and legal names;
- support email;
- exact primary hostname, without scheme or path;
- two-decimal ISO currency and IANA timezone;
- flat shipping and free-shipping threshold in minor units;
- active status.

Request routing first matches an active tenant by `primaryDomain`. Local development and the configured canonical host may fall back to `DEFAULT_TENANT_SLUG`. In production, an unrecognized non-local host fails closed. Set `TRUST_PROXY_HEADERS=true` only behind a proxy that strips client-supplied forwarding headers and supplies a trusted host.

Use a separate database and deployment per brand until multi-tenant operations, staff authorization, provider accounts, domains, cookies, exports, backups, and incident procedures have been deliberately isolation-tested.

## Theme contract

`src/theme/schema.ts` is authoritative. Malformed stored JSON is rejected and the application falls back to `src/theme/default-theme.ts`.

The schema covers brand text/logo, an allowlisted palette, heading/body typography, shape, layout, and social URLs. It accepts an optional root-relative logo image and maps validated values to CSS variables and data attributes. Arbitrary database CSS is not evaluated.

Published themes are versioned and checksummed. Preserve every published version so historical screenshots and audit evidence remain explainable. A theme checksum covers the serialized theme config; it does not cover code-authored copy or asset bytes.

### Code-authored styling and copy

An overlay still needs a source audit:

```bash
rg -n 'Northstar|NORTHSTAR|NS-' src prisma public README.md docs config
rg -n '#[0-9a-fA-F]{3,8}|rgb\(' src/app/globals.css
```

Review at least:

- metadata and structured data in the root layout;
- header/footer navigation and policy links;
- campaign, collection, product, membership, help, account, and admin copy;
- email subjects and bodies in notification templates;
- order-number prefixes and demo credentials;
- literal CSS colors, focus states, editorial sections, and responsive layout.

Keep `APP_URL` equal to the canonical HTTPS origin in production. Verify `/sitemap.xml` and `/robots.txt`; account, admin, login, registration, checkout, and recovery surfaces must not become indexable.

## Assets

Replace all files under `public/demo` and every database asset reference for campaign, prize, product, collection, and winner media. Prefer immutable filenames or content hashes. Supply meaningful alt text, optimize size, and inspect focal points at narrow and wide breakpoints.

Winner publication requires the recorded consent/release for the exact media and disclosure. Prize acceptance is not blanket marketing consent.

## Catalog, shipping, tax, and fulfillment

Products have server-authoritative price, type, category, entry multiplier, images, aggregate inventory, and variants. Variant price and inventory override the product-level values where configured. Collections use an explicit ordered join. Keep public slugs stable or add redirects.

The browser cart is presentation state. Checkout reloads products, variants, prices, inventory, campaign rules, eligibility, and the Official Rules relation before preparing an order.

Product types have these shipped semantics:

- `PHYSICAL`: validates/reserves inventory for hosted checkout and writes fulfillment intent after settlement;
- `DIGITAL`: has no shipping charge, but needs a real delivery consumer;
- `MEMBERSHIP`: must map to an active subscription plan and, in production, a matching Stripe recurring Price. It is deliberately excluded from ordinary shop/search/product routes and rejected by one-time checkout; sell it only through recurring membership enrollment.

Tenant flat shipping and threshold are configurable through the brand overlay. Tax is deliberately zero and non-email fulfillment events do not have a shipped provider consumer. Before launch, integrate and reconcile an authoritative tax service and fulfillment/digital-delivery system. Define destination restrictions, reservation expiry, oversell policy, partial fulfillment, cancellation, return allocation, and carrier/provider idempotency. Shipping availability must not silently redefine promotion eligibility.

## Authoritative entry calculations

Purchase entry rules are active application behavior. Storefront estimates and checkout both use the same targeted rule resolver.

A purchase rule may target `ALL`, `CATEGORY`, `COLLECTION`, `PRODUCT`, or `VARIANT`, with an optional active interval. Every matching active rule contributes this integral factor:

```text
rule factor = entriesPerCurrencyUnit × multiplierNumerator / multiplierDenominator
```

Matching rules stack in ascending, distinct `stackPriority` order. More than one matching rule at the same priority is ambiguous and fails closed. The effective line calculation is:

```text
qualifying whole currency units = floor(unit price × quantity / 100)
entries = qualifying whole units
        × campaign base entries per currency unit
        × catalog product multiplier
        × every matching purchase-rule factor
        × time-resolved campaign multiplier
```

Shipping and tax do not qualify. The campaign-wide cap is applied after the uncapped line calculations in stable order. Each entitlement records its calculation inputs, matched-rule snapshot/version, multiplier-period identity, cap result, campaign checksum, and exact Official Rules evidence.

The multiplier schedule must cover the complete purchase window without gaps or overlap. Checkout resolves it from server time. `Campaign.currentMultiplier` is a projection/fallback; do not use a browser countdown or manually edited value as settlement authority.

When changing rounding, stacking, targets, discounts, bundles, or caps, update the shared pure calculation and tests, publish a new rules/configuration release, and keep old order evidence unchanged.

## AMOE and entrant identity

The AMOE service resolves the active `AMOE_FIXED` rule at submission time, enforces structured campaign location/age assertions and the same campaign-wide entrant cap, and posts approved grants into the same entrant account and ledger used by purchase/subscription entries. In non-demo mode submissions remain pending for staff review; demo mode auto-approves them.

The built-in frequency control is normalized email plus campaign-local date. It is not proof of one natural person or household. Build a documented, appealable review procedure if the Official Rules use a stronger limit. Keep the free route direct, mobile-accessible, free of marketing requirements, and operationally comparable to paid entry.

Checkout, AMOE, and profile paths require a normalized phone/contact value. Contact data helps administration; it does not establish identity by itself.

## Membership bands

A subscription plan controls product, price, currency, billing interval, and provider Price identity. Those plan/product/active-variant facts are bound into every campaign that references the plan. Campaign-specific membership entries are `fixedEntries × band numerator ÷ denominator × the campaign multiplier resolved at paid-invoice time`, then limited by the shared entrant cap. A successful subscription creation alone grants nothing; the signed paid-invoice webhook is authoritative.

Review initial and loyalty bands at every boundary, including a renewal when no campaign is open and a paid invoice arriving after snapshot freeze. A member must accept the exact current Official Rules before a charge can receive campaign entries; an existing member sees the same acceptance control when a new campaign begins. Invoice settlement rechecks the immutable subscription price fingerprint, campaign release integrity, exact rules acceptance and current entrant eligibility. It always records verified money/cycle truth, but records a reasoned zero-entry result when one of those gates fails, and routes eligible post-freeze grants through the adjustment workflow. Keep the plan/Stripe Price amount, currency, cadence, and metadata contract synchronized.

## Exact legal binding and acceptance

Every entrant-visible campaign has a direct relation to one published `OFFICIAL_RULES` row plus the exact version and SHA-256 body checksum. Storefront policy links, checkout, AMOE, notification templates, and acceptance records resolve that campaign-bound document rather than whichever rules happen to be newest.

Checkout, AMOE and membership store `RulesAcceptance` evidence for the exact document/checksum. Marketing consent is a separate optional event. Never bundle marketing consent into entry or Official Rules acceptance.

If the campaign file's version/checksum does not identify one published document effective by campaign start, planning/publishing fails. Never repair a mismatch by updating a campaign or published legal row directly; publish a reviewed new release.

## Account recovery and guest history claims

Registration requires email verification before a normal session is issued. Verification and password recovery use rate-limited, one-hour, single-use challenges; the database stores an HMAC digest rather than the bearer token. A successful password reset revokes all existing sessions.

Verified accounts may safely claim unambiguous guest history for the same normalized email. Ambiguous ownership fails closed into a review ticket rather than silently merging entrants. Customize the recovery emails, support procedure, review SLA, and anti-impersonation evidence before launch.

## Seed strategy

`prisma/seed.ts` creates a moving demonstration clock and fictional users, approvals, filings, transactions, and winners. It refuses production mode and must never be part of a production release.

Bootstrap non-sensitive tenant defaults and the first privileged identities with the validated tenant CLI, then create the initial catalog with the checksummed create-only importer. Publish brand, legal, and campaign releases through their validated CLIs. Start production with an empty reviewed database and never copy demo users, password hashes, approvals, filing receipts, payments, entrants, winners, or draw artifacts.

## Overlay acceptance checklist

- No demo brand, asset, sender, credential, domain, policy, or order prefix remains.
- Tenant/theme/brand/catalog/legal/campaign validators and plans are clean for the target tenant.
- Bootstrap passwords were supplied out of band, removed after use, and distinct staff can log in and rotate into the production identity system.
- Catalog apply was reviewed as a create-only release; its checksum, assets, product/variant identities, collections and recurring Prices are archived.
- Exact Official Rules version/checksum is bound everywhere and acceptance links resolve it.
- Storefront entry estimates equal authoritative checkout settlement at target and time boundaries.
- Purchase, subscription, and AMOE grants share one account, cap, snapshot, and rules release.
- Refunds and late paid renewals behave correctly before freeze, after freeze, and after draw publication.
- Desktop/mobile storefront, checkout, AMOE, account, recovery, policies, admin, and emails are reviewed.
- Catalog, Stripe Prices, shipping, tax, inventory, fulfillment, and returns are reconciled.
- Counsel approvals, filing/bond evidence, draw procedure, winner process, and accessibility evidence reference the exact release checksums.
- All deployment gaps and smoke tests in [Deployment](deployment.md) are closed.
