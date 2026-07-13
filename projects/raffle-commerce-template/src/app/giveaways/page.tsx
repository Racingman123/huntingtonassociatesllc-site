import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ShieldCheck, TicketCheck } from "lucide-react";
import { Container } from "@/components/ui/container";
import { Countdown } from "@/components/storefront/countdown";
import { Disclosure } from "@/components/storefront/disclosure";
import { PageHero } from "@/components/storefront/page-hero";
import { SectionHeading } from "@/components/storefront/section-heading";
import { WinnerCard } from "@/components/storefront/winner-card";
import { formatMoney } from "@/lib/format";
import { getHomeData } from "@/server/storefront";
import { campaignAvailability } from "@/server/campaigns/availability";
import { assertCampaignOfficialRules, officialRulesHref } from "@/lib/official-rules";
import { createStorefrontEntryQuoteLookup } from "@/server/commerce/storefront-quotes";

export const metadata: Metadata = {
  title: "Giveaways",
  description: "Explore the current giveaway, choose a purchase or free entry path, and see verified past winners.",
  alternates: { canonical: "/giveaways" },
};

export default async function GiveawaysPage() {
  const { campaign, products, winners, theme, tenant } = await getHomeData();
  const prize = campaign.prizes[0];
  const availability = campaignAvailability(campaign);
  const entryQuotes = availability.purchaseEntryOpen
    ? createStorefrontEntryQuoteLookup(campaign, products)
    : {};
  const effectiveRates = Object.values(entryQuotes).map((quote) => quote.effectiveMultiplier);
  const purchaseRate = effectiveRates.length
    ? `${Math.min(...effectiveRates)}X–${Math.max(...effectiveRates)}X`
    : "Unavailable";
  return (
    <main className="public-page">
      <PageHero eyebrow={`${theme.brand.shortName} giveaways`} title="One big reason to answer the phone." description="Every campaign has clear dates, a direct free-entry method, versioned rules, and a documented random drawing process." tone="dark">
        <div className="how-hero-badge"><ShieldCheck aria-hidden="true" /><strong>No purchase necessary</strong><span>Free and purchase entries join the same prize drawing.</span></div>
      </PageHero>
      <Disclosure text={campaign.noPurchaseDisclosure} campaignSlug={campaign.slug} officialRulesHref={officialRulesHref(assertCampaignOfficialRules(campaign))} />
      <section className="section giveaway-index-current">
        <Container>
          <div className="giveaway-index-media"><Image src={prize?.image ?? "/demo/giveaway/hero-rig.svg"} alt={prize?.name ?? "Current giveaway prize"} fill loading="eager" sizes="(max-width: 900px) 100vw, 58vw" /><span>{campaign.code}</span></div>
          <div className="giveaway-index-copy"><p className="eyebrow">{availability.publicState === "OPEN" ? "Open now" : availability.publicState === "UPCOMING" ? "Opening soon" : availability.publicState === "FREE_ENTRY_ONLY" ? "Free entry remains open" : "Entry closed"}</p><h2>{campaign.title}</h2><p>{campaign.longDescription}</p><dl><div><dt>Prize value</dt><dd>{formatMoney(prize?.approximateValueCents ?? 0, prize?.currency ?? tenant.currency)}</dd></div><div><dt>Published effective rates</dt><dd>{availability.purchaseEntryOpen ? purchaseRate : "Unavailable"}</dd></div></dl><Countdown target={(availability.publicState === "UPCOMING" ? campaign.startsAt : availability.purchaseEntryOpen ? campaign.endsAt : campaign.freeEntryEndsAt).toISOString()} label={availability.publicState === "UPCOMING" ? "Entry opens in" : availability.purchaseEntryOpen ? "Purchase entry closes in" : "Free entry closes in"} /><div className="button-row"><Link className="button button-primary" href={`/giveaways/${campaign.slug}`}>See prize details</Link>{availability.freeEntryOpen ? <Link className="button button-secondary" href={`/giveaways/${campaign.slug}/free-entry`}><TicketCheck aria-hidden="true" size={18} /> Enter free</Link> : null}</div></div>
        </Container>
      </section>
      {winners.length ? <section className="section section-surface"><Container><SectionHeading eyebrow="Completed campaigns" title="Verified winner archive." href="/winners" linkLabel="View all winners" /><div className="winners-archive-grid">{winners.slice(0, 3).map((winner) => <WinnerCard key={winner.id} winner={winner} />)}</div><Link className="giveaway-archive-link" href="/how-it-works">How drawings are reconciled and conducted <ArrowRight aria-hidden="true" size={18} /></Link></Container></section> : null}
    </main>
  );
}
