# Compliance review guide

> **Not legal advice.** This document is an engineering issue-spotting guide. Sweepstakes, contests, raffles, lotteries, subscriptions, advertising, privacy, accessibility, tax and consumer law vary by jurisdiction and change over time. Retain qualified promotion counsel in every place where the promotion is offered. Counsel must approve the official rules, entry methods, advertising, eligibility, prize, filings/bonds, draw, winner process, data use and operational controls before launch.

The presence of a database field, dashboard check or seeded `APPROVED` record is not legal approval. Verify every linked source and current regulator procedure at the time of each campaign.

## 1. Classify the promotion before configuring it

Counsel should analyze the elements of prize, chance and consideration, the sponsor/beneficiary, geography, entry methods and media. The template is designed around a commercial **sweepstakes** with a genuine free alternative method of entry (AMOE). It is not a generic paid raffle platform.

- A chance promotion that requires payment or purchase can become an unlawful private lottery. The [FTC's advertising guidance](https://www.ftc.gov/business-guidance/resources/advertising-faqs-guide-small-business) states that purchase-required sweepstakes-type promotions are illegal in the United States and advises checking each applicable state.
- A skill contest needs objectively administered skill criteria, not just a different label.
- A raffle is generally a paid chance promotion authorized only for eligible organizations under specific state/local licensing rules. Do not enable raffle mode or sell entries based on this schema without separate counsel and a purpose-built licensed workflow.
- A donation, membership, shipping fee, inflated product price, referral requirement, data/marketing requirement or burdensome AMOE can affect the consideration analysis. Review the full participant experience, not just the rules heading.

Record the approved classification and jurisdiction matrix as release evidence. `Campaign.kind` is descriptive data; it does not make the activity lawful.

## 2. No-purchase method and entry parity

The free route should be clear, direct, genuinely free, available for the approved period and not conditioned on marketing consent. It should lead to the same prize, drawing and eligibility standard. Public advertising must not imply that buying is required or secretly favored.

The [FTC consumer guidance on prizes and sweepstakes](https://consumer.ftc.gov/articles/fake-prize-sweepstakes-and-lottery-scams) says legitimate sweepstakes are free/by chance and warns that a sponsor must not demand payment to claim a prize. For promotions involving U.S. mail, the [U.S. Postal Inspection Service's Publication 546](https://about.usps.com/publications/pub546.pdf) describes required no-purchase and purchase-will-not-improve-chances disclosures, entry/eligibility terms, prize details, selection method and other clear information. Publication 546 specifically concerns mail; counsel must map the rules for web, email, telephone, social and other media.

### Engineering parity test

For each campaign, compare at least:

```text
maximum AMOE entries available to one eligible person
  = fixed AMOE grant × maximum valid submissions in the AMOE window
  (then apply the shared campaign cap)

maximum purchase/subscription entries available to one eligible person
  = all permitted paid grants
  (then apply the same shared campaign cap)
```

Also compare burden, timing, geographic availability, review time, rejection rate, data required and ability to cure an error. A shared `EntryAccount` and shared cap are necessary technical controls, but do not alone prove an acceptable AMOE. If the AMOE math cannot reach an advertised cap or promised equivalence, change the window, grant, frequency, cap and/or approved disclosure before launch. Counsel—not this template—must decide the legally acceptable structure.

The shipped free-entry fingerprint is normalized email + campaign + local date. It does not enforce a natural-person or household rule. Do not advertise a stronger deduplication rule than operations can apply consistently and fairly.

### Control mapping in this repository

| Issue | Implemented foundation | Production work |
| --- | --- | --- |
| Direct access | Linked campaign/free-entry page and sitemap entry | Verify every advertisement/landing page and applicable platform rules |
| Same pool | Free and paid grants use one campaign/entrant account | End-to-end reconciliation and cross-channel tests |
| Same cap | Both services read `maxEntriesPerEntrant` | Numeric AMOE reachability and burden review |
| Separate marketing | Free form has no marketing checkbox; checkout consent is optional | Audit every CRM/import/referral path |
| Review | Non-demo submissions remain `PENDING` for a role-protected decision with reason/audit evidence | Documented appeal/cure policy, reviewer training and service levels |
| Rules proof | Campaign and acceptance bind the exact published document/checksum; legal/campaign release publishers are role-separated | Immutable external evidence and promotion-specific counsel signoff |

## 3. Official rules and short disclosures

Official rules should be promotion-specific and internally consistent. Counsel commonly reviews:

- sponsor and, if different, administrator legal names and addresses;
- clear “no purchase necessary / purchase will not increase chances” disclosure;
- eligible jurisdictions, age/age of majority, exclusions and “void where prohibited” scope;
- exact start/end/cutoff instants and controlling timezone/server clock;
- every entry method, frequency/household limit, cap, multiplier, rounding rule and treatment of incomplete/late/duplicate entries;
- prize quantity, complete description, approximate retail value, cash alternative/substitution, restrictions, delivery, taxes, title/registration/insurance and unclaimed prize handling;
- odds statement and how the random/skill selection is conducted;
- provisional selection, identity/eligibility verification, notification channels, response deadlines, alternates and disqualification standards;
- refunds, cancellations, disputes, chargebacks and their entry effect;
- fraud/technical failure rules that are not arbitrary and preserve regulator/court rights;
- privacy use, winner list, publicity release and record retention;
- limitations, disputes, governing law and rights that cannot be waived;
- how to obtain rules and winner information.

Place material terms where people make decisions; a link to long rules does not cure a misleading headline. Multipliers, “automatic entries,” countdowns, maximum entry claims, cash values, scarcity and winner testimonials must be truthful and substantiated under the [FTC's advertising principles](https://www.ftc.gov/business-guidance/resources/advertising-faqs-guide-small-business).

Publish rules as immutable versions and store the checksum actually accepted. Do not materially alter a live campaign without counsel's written instruction, updated evidence, required notice and regulator action.

## 4. U.S. registration, bonding and state review

State requirements are not limited to the examples below. Eligibility, prize type/value, entry medium, retail presence, sponsor location, duration and advertising footprint can change the result. Have counsel prepare a 50-state (plus D.C./territory, as applicable) matrix and update it for every campaign.

Common launch checks include:

- **Florida.** [Florida Statutes § 849.094](https://www.leg.state.fl.us/Statutes/index.cfm?App_mode=Display_Statute&URL=0800-0899%2F0849%2FSections%2F0849.094.html) addresses game promotions connected to consumer products/services. It prohibits requiring entry fees/payment/proof of purchase and, for announced prizes above $5,000, includes advance rules/prize filing and trust/bond requirements. Verify the current form, timing, exemptions, bond amount and winner-list obligations with Florida and counsel.
- **New York.** The [New York Department of State Games of Chance Registration page](https://dos.ny.gov/games-chance-registration) describes registration for chance promotions connected with consumer products/services when total prize value exceeds $5,000, including rules, a certificate of deposit or surety bond, and post-promotion winner certification. Confirm current General Business Law § 369-e, regulations, filing lead time, valuation and exemptions.
- **Rhode Island.** [R.I. Gen. Laws § 11-50-1](https://webserver.rilegislature.gov/statutes/title11/11-50/11-50-1.HTM) describes a filing for certain chance promotions in which a retail establishment promotes its business and announced prize value exceeds $500. The [current Secretary of State form](https://docs.sos.ri.gov/documents/BusinessServices/660-games-of-chance.pdf) shows the information and fee requested. Counsel must determine whether the sponsor/activity is within scope and satisfy posting/record rules in the rest of Chapter 11-50.

`FilingRequirement` can track a jurisdiction, trigger, due date, status, receipt/evidence or a reviewed waiver rationale. It is a task/evidence record, not an automated legal rules engine. Do not copy the seed's fictional completed filings.

## 5. Mail, telephone, email and social channels

Each medium adds rules beyond the website.

### U.S. mail and telephone

- Review mail pieces against the [USPS/USPIS sweepstakes guide](https://about.usps.com/publications/pub546.pdf) and applicable postal law. Required mail disclosures must appear in the mailing/entry material as required; a website link may be insufficient.
- Telemarketing prize promotions have specific disclosures under the FTC's [Telemarketing Sales Rule guidance](https://www.ftc.gov/business-guidance/resources/complying-telemarketing-sales-rule). Review do-not-call, consent, recording and state telemarketing requirements before any call/SMS program.

### U.S. commercial email

The FTC's [CAN-SPAM compliance guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business) covers accurate headers/subject lines, ad identification, physical postal address, a working opt-out and honoring opt-outs; a sender cannot contract away responsibility to a vendor. Incentivized “forward to a friend” or referral entries can create additional sender/initiator concerns.

The template records opt-in consent/subscriber status and can deliver bounded transactional outbox messages through Resend. It does not ship a marketing unsubscribe/preference center or bounce, complaint and suppression propagation. Implement and test those before sending marketing. Transactional messages should remain limited to their transactional purpose.

### Canada (if included)

Canada is outside the seeded eligibility area. If a future campaign includes it:

- The Competition Bureau's [Promotional Contests enforcement guidelines](https://competition-bureau.canada.ca/en/promotional-contests-enforcement-guidelines) discuss disclosure of prize number/approximate value, regional allocation and information affecting chances, timely prize distribution and random/skill selection under Competition Act § 74.06.
- [Canada's Anti-Spam Legislation consent guidance](https://ised-isde.canada.ca/site/canada-anti-spam-legislation/en/getting-consent-send-email) describes consent, identification/contact information and unsubscribe requirements for commercial electronic messages. [CRTC consent record guidance](https://www.canada.ca/en/radio-television-telecommunications/news/2016/07/enforcement-advisory-notice-for-businesses-and-individuals-on-how-to-keep-records-of-consent.html) explains the sender's burden to prove consent and recommends retaining opt-in/unsubscribe evidence.
- Have Canadian counsel assess the Criminal Code structure, any skill-testing requirement, provincial consumer/privacy/language rules, Québec/French presentation, tax and fulfillment. Do not simply change `country` validation from `US`.

### Social platforms and endorsements

Review each platform's current promotion terms, required release/disclaimer, sharing/tagging restrictions and prohibited mechanics. Paid creators and employee endorsements must follow the FTC's current [Endorsement Guides resources](https://www.ftc.gov/business-guidance/advertising-marketing/endorsements-influencers-reviews). Do not grant entries for spammy or non-verifiable social actions without specific counsel/platform review and an auditable fulfillment method.

## 6. Privacy and data governance

Map data by purpose before collection. This template may store account identity, hashed/session identifiers, entrant email/name/region/postal code, checkout address, eligibility attestations, order/payment references, support messages, consent events, device/abuse-derived fingerprints, entries, audit records and winner information.

Production review should cover:

- privacy notice/controller/sponsor identity and contact;
- lawful purpose/basis, collection notice and sensitive-data minimization;
- state, federal and international consumer rights and appeal processes;
- service-provider contracts, payment/CRM/administrator disclosures and cross-border transfers;
- retention by record type, tax/filing/dispute holds, deletion and de-identification;
- access controls for entrant, support, winner-claim and tax documents;
- cookies/analytics/advertising technology and opt-out signals;
- incident response and breach-notification matrix;
- data-subject request identity verification and export/correction/deletion workflow.

The FTC provides general [privacy and data security guidance for businesses](https://www.ftc.gov/business-guidance/privacy-security). Avoid collecting full identity, tax or banking documents from every entrant; collect them securely from provisional winners only when required. Do not put raw personal data in logs, outbox payloads or immutable public artifacts.

The campaign is intended for adults, but age attestation alone does not eliminate children's-privacy risk. Review data collection and audience practices against the FTC's [Children's Privacy guidance](https://www.ftc.gov/business-guidance/privacy-security/childrens-privacy) and applicable state/international rules.

## 7. Marketing consent is not entry consent

Rules acceptance, eligibility attestation, account/service messages and marketing authorization are different records.

- Marketing choices must be optional and must not change entries, odds or AMOE review.
- Store the exact disclosure/policy version, channel, source, time and subject identity needed to prove the choice.
- Record withdrawal as a new consent event and update suppression status; preserve legally required evidence.
- Do not pre-check consent, hide it in official rules or infer broad consent from entering.
- Keep email, SMS, telephone and targeted-ad choices separate where applicable.

The template has `ConsentEvent` and `NewsletterSubscriber`; production still needs unsubscribe/withdrawal routes, preference center, downstream suppression propagation and vendor reconciliation.

## 8. Accessibility and equal access

Adopt a documented target such as [WCAG 2.2 Level AA](https://www.w3.org/TR/WCAG22/) for the full participant experience. WCAG conformance is an engineering target, not by itself a legal conclusion; counsel should assess applicable disability/access laws.

Test with automated tools and people using keyboards, screen readers, magnification, high contrast, reduced motion and mobile devices. Include:

- campaign disclosures, countdowns and odds/rules links;
- product options, cart and checkout errors;
- AMOE form, confirmation and review/cure communications;
- account order/entry tables;
- identity/winner-claim process and uploaded documents;
- CAPTCHA/fraud challenges with accessible alternatives;
- email/PDF/mail versions of rules.

The theme/brand validators compute WCAG AA contrast for the shared text/color pairs they know about. That is only a partial automated check: every overlay must still test all normal/large text, focus indicators, semantic states, images/overlays and third-party checkout/claim pages. Do not make the AMOE less accessible than purchase entry.

## 9. Fraud controls and fair administration

Use proportionate signals to queue review, not to silently remove legitimate entries. Document:

- bot/rate protections and accessible alternatives;
- duplicate identity/household policy that matches the rules;
- device/IP/email/payment/address signals and false-positive handling;
- reviewer evidence, reason codes, conflicts and appeal/escalation;
- consistent treatment of paid and free entrants;
- sanctions against arbitrary rejection or post-hoc rule changes;
- security monitoring for credential stuffing, admin abuse, webhook forgery and winner impersonation.

Florida's statute expressly addresses manipulation, arbitrary rejection, failure to award and deceptive material; regardless of geography, those are useful integrity controls. Preserve an append-only audit trail and ordered alternates so no operator can manually choose a winner.

## 10. Draw, winner and prize controls

Before the draw:

- close every approved entry path at the correct instant;
- reconcile provider, refund, subscription, AMOE, eligibility and ledger state;
- resolve documented exceptions under the rules;
- create a canonical, checksummed snapshot and obtain required approvals;
- preserve it in immutable storage.

Use the rules-approved random/skill procedure and preferably an independent administrator. Separate operator, witness, reconciliation and winner-verification duties. Preserve algorithm/version or administrator certificate, seed/result commitments where applicable, custody, checksum, ordered candidates and all decisions.

A selected person is provisional until eligibility is verified. Contact them only through approved channels. Never require payment to receive a prize. Collect affidavits, releases, tax forms and identity evidence through a secure minimum-access process. Publish only approved information and honor post-promotion filing/winner-list obligations.

Have tax counsel/accounting determine sponsor reporting and winner tax communications. Do not tell participants that a prize is “tax free” or provide personal tax advice.

## 11. Refunds, cancellations and recurring billing

Rules and consumer-facing policies must accurately disclose:

- what is purchased independent of the sweepstakes;
- shipping/return/cancellation terms;
- whether and how refunds, disputes and chargebacks reverse entries;
- consequences of partial refunds and post-close transactions;
- subscription price/cadence, renewal authorization, cancellation path/effective time and renewal-entry treatment;
- what happens when no campaign is active at renewal.

Recurring billing is regulated separately from sweepstakes law. Review federal/state automatic-renewal, negative-option and card-network requirements for the offered jurisdictions. The template has Stripe-hosted subscription Checkout and Billing Portal plus signed invoice/state webhooks, but those technical controls do not establish compliant enrollment copy, renewal notices, cancellation timing or jurisdiction coverage.

## 12. Required human approvals

The campaign overlay requires exactly one of each built-in operational approval kind:

- `LEGAL_RULES`
- `PRIZE_FUNDING`
- `AMOE_PARITY`
- `DRAW_PROCEDURE`
- `ACCESSIBILITY`

They are created with evidence/notes and tied to the exact configuration/rules checksum. The publisher attributes prize funding to the sponsor admin and the other four to the compliance witness. If production needs additional approvals (privacy/data map, marketing claims, tax, fulfillment, security, provider reconciliation, subscription terms), extend and test the overlay schema/publisher or preserve them in the external release package; arbitrary extra kinds are not accepted by the built-in JSON contract. Any material change invalidates the old approval.

## 13. Counsel handoff checklist

Provide counsel with:

- sponsor/entity and all administrators/vendors;
- complete rules and every short-form ad/landing page/email/social script;
- jurisdiction/age/audience plan and geofencing limitations;
- exact campaign clock, entry formulas, examples, cap and AMOE reachability table;
- prize ownership/valuation, cash alternative, delivery and tax plan;
- purchase, refund, dispute, subscription and AMOE operational diagrams;
- fraud/review/appeal and accessibility procedures;
- data inventory, privacy notice, marketing consent and retention schedule;
- state filing/bond matrix and draft forms;
- snapshot/draw/custody/winner verification procedure;
- production security, incident and business-continuity plan.

Ask for written approval of the final checksummed release, not a general opinion about an earlier concept.
