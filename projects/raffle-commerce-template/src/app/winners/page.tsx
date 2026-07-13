import type { Metadata } from "next";
import Link from "next/link";
import { BadgeCheck, Search, ShieldCheck } from "lucide-react";
import { Container } from "@/components/ui/container";
import { PageHero } from "@/components/storefront/page-hero";
import { WinnerCard } from "@/components/storefront/winner-card";
import { getActiveCampaign, getPublishedWinners, getTenant } from "@/server/storefront";

export const metadata: Metadata = {
  title: "Past Winners",
  description: "Meet published, verified giveaway winners and explore their prize stories.",
  alternates: { canonical: "/winners" },
};

type SearchParams = Promise<{ q?: string | string[]; sort?: string | string[] }>;

export default async function WinnersPage({ searchParams }: { searchParams: SearchParams }) {
  const [allWinners, campaign, tenant, query] = await Promise.all([getPublishedWinners(), getActiveCampaign(), getTenant(), searchParams]);
  const search = typeof query.q === "string" ? query.q.trim() : "";
  const sort = typeof query.sort === "string" ? query.sort : "newest";
  const normalized = search.toLocaleLowerCase();
  const winners = allWinners.filter((winner) => !normalized || [
    winner.publicName ?? "",
    winner.publicLocation ?? "",
    winner.prize.name,
    winner.campaign.title,
  ].some((value) => value.toLocaleLowerCase().includes(normalized)));
  if (sort === "oldest") winners.sort((a, b) => (a.publishedAt?.getTime() ?? 0) - (b.publishedAt?.getTime() ?? 0));
  if (sort === "name") winners.sort((a, b) => (a.publicName ?? "").localeCompare(b.publicName ?? ""));
  if (sort === "value") winners.sort((a, b) => b.prize.approximateValueCents - a.prize.approximateValueCents);
  return (
    <main className="public-page">
      <PageHero eyebrow="Winner archive" title="The call you don’t forget." description={`A public record of verified ${tenant.displayName} winners. We publish only after the selected entrant completes the claim and eligibility process.`} tone="accent">
        <div className="winner-proof"><BadgeCheck aria-hidden="true" /><strong>{allWinners.length} published winner{allWinners.length === 1 ? "" : "s"}</strong><span>in this demonstration archive</span></div>
      </PageHero>
      <section className="winner-integrity-bar">
        <Container>
          <ShieldCheck aria-hidden="true" />
          <p><strong>Winner safety:</strong> {tenant.displayName} never requires payment, gift cards, or banking credentials to release a prize.</p>
          <Link href="/scam-awareness">Learn what to expect</Link>
        </Container>
      </section>
      <section className="section winners-archive">
        <Container>
          <form className="winner-toolbar" action="/winners" method="get" role="search">
            <label><Search aria-hidden="true" /><span className="sr-only">Search winner archive</span><input name="q" type="search" defaultValue={search} placeholder="Search winner, place, campaign, or prize" /></label>
            <label><span className="sr-only">Sort winners</span><select name="sort" defaultValue={sort}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="name">Winner name</option><option value="value">Highest prize value</option></select></label>
            <button className="button button-primary" type="submit">Apply</button>
            {search || sort !== "newest" ? <Link className="text-link" href="/winners">Clear</Link> : null}
          </form>
          <p className="winner-results-count" aria-live="polite">{winners.length} published record{winners.length === 1 ? "" : "s"}</p>
          {winners.length ? <div className="winners-archive-grid">
            {winners.map((winner, index) => <WinnerCard key={winner.id} winner={winner} featured={index === 0} />)}
          </div> : <div className="empty-state"><Search aria-hidden="true" /><h2>No winner record matched.</h2><p>Try a broader search or clear the archive filters.</p><Link className="button button-primary" href="/winners">Clear filters</Link></div>}
        </Container>
      </section>
      <section className="winner-next-cta">
        <Container>
          <p className="eyebrow">Your name would look good here</p>
          <h2>There is always a free way to enter.</h2>
          <p>A purchase is never required and does not guarantee a prize. Review the live campaign and choose the entry path that works for you.</p>
          <div className="button-row"><Link className="button button-accent" href={`/giveaways/${campaign.slug}`}>View current giveaway</Link><Link className="button button-glass" href={`/giveaways/${campaign.slug}/free-entry`}>Enter free</Link></div>
        </Container>
      </section>
    </main>
  );
}
