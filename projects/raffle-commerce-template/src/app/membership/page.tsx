import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { BadgePercent, CalendarSync, Check, CreditCard, Gift, ShieldCheck, X } from "lucide-react";
import { Container } from "@/components/ui/container";
import { Disclosure } from "@/components/storefront/disclosure";
import { FaqList } from "@/components/storefront/faq-list";
import { MembershipEnrollButton } from "@/components/membership/enroll-button";
import { SectionHeading } from "@/components/storefront/section-heading";
import { formatEntries, formatMoney } from "@/lib/format";
import { getActiveCampaign, getTenant } from "@/server/storefront";
import { getMembershipOffers } from "@/server/subscriptions/dal";
import { selectMembershipEntryBand } from "@/server/subscriptions/calculation";
import { campaignAvailability } from "@/server/campaigns/availability";
import { assertCampaignOfficialRules, officialRulesHref } from "@/lib/official-rules";

export const metadata: Metadata = {
  title: "Basecamp Membership",
  description: "Explore membership benefits, monthly delivery, cancellation terms, and promotional entry disclosures.",
  alternates: { canonical: "/membership" },
};

export default async function MembershipPage() {
  const [campaign, tenant] = await Promise.all([getActiveCampaign(), getTenant()]);
  const membership = await getMembershipOffers(campaign.id);
  const availability = campaignAvailability(campaign);
  const officialRules = assertCampaignOfficialRules(campaign);
  const rulesHref = officialRulesHref(officialRules);
  const featured = membership.offers[0] ?? null;
  const initialQuote = (offer: (typeof membership.offers)[number]) => {
    if (!availability.purchaseEntryOpen) return null;
    try {
      const band = selectMembershipEntryBand(offer.entryBands, 0);
      const calculated = band.fixedEntries
        * BigInt(band.multiplierNumerator)
        * BigInt(campaign.currentMultiplier)
        / BigInt(band.multiplierDenominator);
      return campaign.maxEntriesPerEntrant != null && calculated > campaign.maxEntriesPerEntrant
        ? campaign.maxEntriesPerEntrant
        : calculated;
    } catch {
      return null;
    }
  };
  return (
    <main className="public-page">
      <section className="membership-hero">
        <Container>
          <div className="membership-hero-copy">
            <p className="eyebrow">{featured?.product.title ?? "Membership"}</p><h1>More trail time. Less full-price gear.</h1>
            <p>A simple monthly membership for the people who keep a go-bag packed: store credit, member pricing, early drop access, and a useful digital field pack every month.</p>
            <ul><li><Check aria-hidden="true" /> {featured ? `Plans from ${formatMoney(featured.priceCents, tenant.currency)}` : "Plans configured by your operator"}</li><li><Check aria-hidden="true" /> Cancel before your next renewal</li><li><Check aria-hidden="true" /> No purchase required to enter any giveaway</li></ul>
          </div>
          <div className="membership-card-stack">
            {membership.offers.map((offer, index) => {
              const entries = initialQuote(offer);
              return (
                <article className="membership-card" key={offer.id}>
                  <div className="membership-card-art"><Image src={offer.product.image} alt={`${offer.product.title} member pass`} fill loading={index === 0 ? "eager" : "lazy"} sizes="(max-width: 850px) 100vw, 24vw" /></div>
                  <div><span>{offer.name}</span><strong>{formatMoney(offer.priceCents, offer.currency)}<small>/{offer.interval === "MONTH" && offer.intervalCount === 1 ? "mo" : `${offer.intervalCount} ${offer.interval.toLowerCase()}`}</small></strong><p>{entries == null ? "No promotional entry award is currently configured." : <>Current initial-purchase quote: <b>{formatEntries(entries)} entries</b></>}</p><MembershipEnrollButton planId={offer.id} idempotencyKey={`enroll:${randomUUID()}`} signedIn={Boolean(membership.viewer)} alreadyActive={Boolean(offer.existing)} demoMode={process.env.DEMO_MODE === "true"} campaignId={campaign.id} officialRulesHref={rulesHref} rulesRequired={entries !== null} rulesAccepted={membership.currentRulesAccepted} /></div>
                </article>
              );
            })}
            {!membership.offers.length ? <p role="alert">Membership enrollment is currently unavailable.</p> : null}
          </div>
        </Container>
      </section>
      <Disclosure text={campaign.noPurchaseDisclosure} campaignSlug={campaign.slug} officialRulesHref={rulesHref} compact />

      <section className="section membership-benefits">
        <Container>
          <SectionHeading eyebrow="What’s inside" title="Perks built for regulars." />
          <div className="benefit-grid">
            <article><CreditCard aria-hidden="true" /><h3>Monthly value</h3><p>A fresh digital field pack and member credit delivered to your account each billing cycle.</p></article>
            <article><BadgePercent aria-hidden="true" /><h3>Member pricing</h3><p>A personal discount on eligible full-price {tenant.displayName} products while your membership is active.</p></article>
            <article><Gift aria-hidden="true" /><h3>Early drop access</h3><p>First look at limited product releases and periodic loyalty surprises, while supplies last.</p></article>
            <article><CalendarSync aria-hidden="true" /><h3>Easy control</h3><p>See your next billing date and cancel future renewals from the member portal.</p></article>
          </div>
        </Container>
      </section>

      <section className="membership-entries section section-dark">
        <Container>
          <div><p className="eyebrow">About promotional entries</p><h2>Membership and sweepstakes are separate.</h2><p>The membership is a recurring product. Any entry award on an initial purchase or later paid renewal is calculated under the campaign active at that transaction and recorded as a separate paid order. A future campaign may have a different multiplier—or no purchase promotion at all.</p><Link className="text-link" href="/how-it-works">See how entry records work</Link></div>
          <ul><li><ShieldCheck aria-hidden="true" /><span><strong>No guaranteed prize</strong> Membership never guarantees selection or special winner treatment.</span></li><li><X aria-hidden="true" /><span><strong>No required membership</strong> Every promotion offers a free method with equivalent access to the prize.</span></li><li><CalendarSync aria-hidden="true" /><span><strong>Renewal-time calculation</strong> Entries use the disclosed rate in effect when that renewal is paid.</span></li></ul>
        </Container>
      </section>

      <section className="section faq-section">
        <Container><SectionHeading eyebrow="Membership questions" title="Know before you join." /><FaqList items={[
          { question: "When will I be billed?", answer: <p>Your first charge occurs when you join. Future charges occur on the disclosed monthly renewal date until canceled. Your account shows the upcoming date before each renewal.</p> },
          { question: "How do I cancel?", answer: <p>Cancel future renewals from your account before the next billing date or contact support. Cancellation stops future charges and does not retroactively refund benefits already delivered.</p> },
          { question: "Does membership enter me in every giveaway?", answer: <p>Only a qualifying paid order or renewal during an eligible campaign can earn the entries disclosed for that transaction. Membership itself does not bypass eligibility, entry caps, dates, or Official Rules.</p> },
          { question: "Can I enter without being a member?", answer: <p>Yes. Membership is never required. You may enter the current giveaway using its direct no-purchase method, subject to the Official Rules.</p> },
        ]} /></Container>
      </section>
    </main>
  );
}
