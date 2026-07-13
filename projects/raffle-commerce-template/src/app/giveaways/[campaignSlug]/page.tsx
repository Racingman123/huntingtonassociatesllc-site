import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { BadgeCheck, CalendarClock, CircleDollarSign, FileCheck2, Gift, ShieldCheck, TicketCheck } from "lucide-react";
import { ButtonLink } from "@/components/ui/button-link";
import { Container } from "@/components/ui/container";
import { Countdown } from "@/components/storefront/countdown";
import { Disclosure } from "@/components/storefront/disclosure";
import { FaqList } from "@/components/storefront/faq-list";
import { ProductGrid } from "@/components/storefront/product-grid";
import { SectionHeading } from "@/components/storefront/section-heading";
import { formatDateTime, formatEntries, formatMoney } from "@/lib/format";
import { getAllProducts, getCampaign, getTenant } from "@/server/storefront";
import { campaignAvailability } from "@/server/campaigns/availability";
import { assertCampaignOfficialRules, officialRulesHref } from "@/lib/official-rules";
import { createStorefrontEntryQuoteLookup } from "@/server/commerce/storefront-quotes";

export async function generateMetadata({ params }: { params: Promise<{ campaignSlug: string }> }): Promise<Metadata> {
  const { campaignSlug } = await params;
  const campaign = await getCampaign(campaignSlug);
  return {
    title: campaign.title,
    description: `${campaign.shortDescription} No purchase necessary. See Official Rules for details.`,
    alternates: { canonical: `/giveaways/${campaign.slug}` },
  };
}

export default async function GiveawayPage({ params }: { params: Promise<{ campaignSlug: string }> }) {
  const { campaignSlug } = await params;
  const [campaign, products, tenant] = await Promise.all([getCampaign(campaignSlug), getAllProducts(), getTenant()]);
  const prize = campaign.prizes[0];
  const freeEntryRule = campaign.entryRules.find((rule) => rule.targetType === "FREE_ENTRY");
  const featured = products.filter((product) => product.featured).slice(0, 4);
  const availability = campaignAvailability(campaign);
  const rulesHref = officialRulesHref(assertCampaignOfficialRules(campaign));
  const entryQuotes = availability.purchaseEntryOpen
    ? createStorefrontEntryQuoteLookup(campaign, featured)
    : {};

  return (
    <main className="public-page">
      <section className="giveaway-detail-hero">
        <div className="giveaway-detail-media">
          <Image src={prize?.image ?? "/demo/giveaway/hero-rig.svg"} alt={prize?.name ?? "Current giveaway prize"} fill loading="eager" sizes="100vw" />
        </div>
        <Container className="giveaway-detail-overlay">
          <div className="giveaway-detail-copy">
            <p className="campaign-kicker">{campaign.eyebrow} <span>{campaign.code}</span></p>
            <h1>{campaign.title}</h1>
            <p>{campaign.longDescription}</p>
            <div className="button-row">
              {availability.purchaseEntryOpen ? <ButtonLink href="/shop" variant="light">Shop & earn entries</ButtonLink> : null}
              {availability.freeEntryOpen ? <ButtonLink href={`/giveaways/${campaign.slug}/free-entry`} variant="ghost">Enter free</ButtonLink> : null}
              {availability.publicState === "CLOSED" ? <ButtonLink href="/winners" variant="light">Winner updates</ButtonLink> : null}
            </div>
            <p className="fine-print">{campaign.noPurchaseDisclosure}</p>
          </div>
          <Countdown
            target={(availability.publicState === "UPCOMING"
              ? campaign.startsAt
              : availability.purchaseEntryOpen ? campaign.endsAt : campaign.freeEntryEndsAt).toISOString()}
            label={availability.publicState === "UPCOMING"
              ? "Entry opens in"
              : availability.purchaseEntryOpen ? "Purchase entry closes in" : "Free entry closes in"}
          />
        </Container>
      </section>
      <Disclosure text={campaign.noPurchaseDisclosure} campaignSlug={campaign.slug} officialRulesHref={rulesHref} />

      <section className="prize-overview section">
        <Container>
          <SectionHeading eyebrow="The grand prize" title="Ready for the long way home." description={campaign.shortDescription} />
          <div className="prize-overview-grid">
            <div className="prize-overview-copy">
              <p>{prize?.description}</p>
              <dl className="prize-facts">
                <div><dt>Approximate retail value</dt><dd>{formatMoney(prize?.approximateValueCents ?? 0, prize?.currency ?? tenant.currency)}</dd></div>
                <div><dt>Cash alternative</dt><dd>{prize?.cashAlternativeCents ? formatMoney(prize.cashAlternativeCents, prize.currency) : "See rules"}</dd></div>
                <div><dt>Prize quantity</dt><dd>{prize?.quantity ?? 1}</dd></div>
                <div><dt>Drawing target</dt><dd>{campaign.drawAt ? formatDateTime(campaign.drawAt, campaign.timezone) : "After verification"}</dd></div>
              </dl>
              <Link className="text-link" href={rulesHref}>Read complete prize restrictions <FileCheck2 aria-hidden="true" size={18} /></Link>
            </div>
            <div className="prize-callout">
              <span><Gift aria-hidden="true" /></span>
              <p>One verified winner receives the complete package shown in the Official Rules.</p>
            </div>
          </div>
        </Container>
      </section>

      <section className="entry-methods section section-dark">
        <Container>
          <SectionHeading eyebrow="Choose your way in" title="Two entry methods. One shared drawing." inverse />
          <div className="entry-method-grid">
            <article>
              <span className="method-number">01</span>
              <CircleDollarSign aria-hidden="true" />
              <h3>Purchase entry</h3>
              <p>Qualifying whole currency units {availability.purchaseEntryOpen ? "earn" : "earned"} {campaign.baseEntriesPerDollar} base entry each, multiplied exactly once by the catalog product rate, every matching published purchase rule, and the scheduled campaign rate.</p>
              {availability.purchaseEntryOpen ? <ButtonLink href="/shop" variant="light">Shop qualifying gear</ButtonLink> : <p><strong>{availability.publicState === "UPCOMING" ? "Purchase entry has not opened." : "Purchase entry is closed."}</strong></p>}
            </article>
            <article className="entry-method-free">
              <span className="method-number">02</span>
              <TicketCheck aria-hidden="true" />
              <h3>Free online entry</h3>
              <p>Submit the separate no-purchase form for {formatEntries(freeEntryRule?.baseEntries ?? 25_000n)} entries per valid submission, subject to the frequency and cap in the Official Rules.</p>
              {availability.freeEntryOpen ? <ButtonLink href={`/giveaways/${campaign.slug}/free-entry`} variant="primary">Go to free entry form</ButtonLink> : <p><strong>{availability.publicState === "UPCOMING" ? "Free entry has not opened." : "Free entry is closed."}</strong></p>}
            </article>
          </div>
          <p className="equal-entry-note"><ShieldCheck aria-hidden="true" /> Purchase and free entries use the same eligibility rules, entry cap, sealed ledger, drawing, and prize.</p>
        </Container>
      </section>

      <section className="section campaign-timeline-section">
        <Container>
          <SectionHeading eyebrow="Mark the dates" title="Campaign timeline." />
          <ol className="campaign-timeline">
            <li><span><CalendarClock aria-hidden="true" /></span><div><small>Entry opens</small><strong>{formatDateTime(campaign.startsAt, campaign.timezone)}</strong></div></li>
            <li><span><TicketCheck aria-hidden="true" /></span><div><small>Purchase entry closes</small><strong>{formatDateTime(campaign.endsAt, campaign.timezone)}</strong></div></li>
            <li><span><BadgeCheck aria-hidden="true" /></span><div><small>Target drawing date</small><strong>{campaign.drawAt ? formatDateTime(campaign.drawAt, campaign.timezone) : "Published after reconciliation"}</strong></div></li>
          </ol>
          <p className="timeline-note">The server timestamp controls. Free entry remains available through {formatDateTime(campaign.freeEntryEndsAt, campaign.timezone)}.</p>
        </Container>
      </section>

      <section className="section section-surface">
        <Container>
          <SectionHeading
            eyebrow={availability.purchaseEntryOpen ? "PUBLISHED ENTRY QUOTES LIVE" : availability.publicState === "UPCOMING" ? "ENTRY OPENS SOON" : "PURCHASE ENTRY CLOSED"}
            title={availability.purchaseEntryOpen ? "Gear you’ll keep. Entries automatically recorded." : availability.publicState === "UPCOMING" ? "Preview the collection before entry opens." : "The entry window has ended."}
            href={availability.purchaseEntryOpen ? "/shop" : undefined}
            linkLabel={availability.purchaseEntryOpen ? "Shop all products" : undefined}
          />
          <ProductGrid products={featured} entryQuotes={entryQuotes} entriesAvailable={availability.purchaseEntryOpen} currency={tenant.currency} />
        </Container>
      </section>

      <section className="section faq-section">
        <Container>
          <SectionHeading eyebrow="Before you enter" title="Campaign questions." />
          <FaqList items={[
            { question: "Who is eligible?", answer: <p>{campaign.eligibilitySummary} Always review the Official Rules before entering.</p> },
            { question: "Does buying more guarantee a win?", answer: <p>No. Winners are randomly selected. A purchase does not guarantee a prize, and making a purchase is not required to enter.</p> },
            { question: "What is the maximum number of entries?", answer: <p>The shared maximum is {campaign.maxEntriesPerEntrant ? formatEntries(campaign.maxEntriesPerEntrant) : "stated in the Official Rules"} entries per verified entrant identity across all methods. Normalized email groups intake; administrator review addresses duplicate identities under the Official Rules.</p> },
            { question: "When will the winner be announced?", answer: <p>After entry reconciliation, the random drawing, and identity and eligibility verification. Never trust a social-media message asking for money to release a prize.</p> },
          ]} />
        </Container>
      </section>
    </main>
  );
}
