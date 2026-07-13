# Reference surface and template coverage

The public experience was benchmarked against [LGND Supply Co.](https://lgndsupplyco.com/) in July 2026. This project reproduces the useful system patterns, not LGND's proprietary code, copy, artwork, customer data, or branding.

| Public pattern | Template implementation |
| --- | --- |
| Campaign-first home page, announcement, countdown and entry rate | Database-backed campaign hero, authoritative half-open entry windows, scheduled multiplier periods and lifecycle-aware calls to action |
| Quick-entry products and ordinary merchandise | Digital and physical products, variants, collections, cart persistence, server-authoritative pricing, entry quotes and inventory reservations |
| Current giveaway details and rules link | Prize schedule, approximate value, cash alternative, entry methods, independent cutoffs, eligibility summary, versioned Official Rules and legal history |
| No-purchase entry | Direct online AMOE route, separate consent, structured eligibility, frequency/cap enforcement, review queue, receipts and the same entry account |
| Membership offers and member portal | Recurring plans, initial/renewal orders, tenure bands, Stripe Checkout/Billing Portal, cancellation lifecycle and zero-entry paid cycles outside an eligible campaign |
| Customer login and combined entry history | Hashed database sessions, verified-email guest-history claim, orders, subscriptions and append-only entry ledger |
| Past winners and winner safety | Searchable winner archive, detail pages, scam guidance, ordered draw candidates, verification, consented publication and fulfillment evidence |
| Help, policies and support | Help center, versioned policies, support intake, tenant-scoped staff queue and audited status changes |
| Category navigation and search | Collection pages, full shop, product search and responsive desktop/mobile navigation |

## Integrity and operator coverage beyond the public reference

The template also includes controls that are not normally visible on a storefront: exact rules/configuration checksums, role-separated AMOE review, append-only audit and entry records, two-person snapshot sealing, post-freeze refund cases, winner disposition controls, webhook idempotency, rate limits, transactional email leases, maintenance jobs, readiness checks, and disposable integration/browser test environments.

## Deliberate non-copies

Marketing-only features such as a native mobile app, customer-review feed, editorial news feed, charity campaign modules, and a geographic winner map are not coupled to promotion integrity. They can be added through the public APIs and published-winner/catalog data without changing the ledger or draw model. The included Northstar content is fictional and should be replaced through the brand, campaign, catalog, asset and legal release process.
