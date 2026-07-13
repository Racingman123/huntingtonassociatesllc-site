import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, BadgeCheck, MapPin, ShieldCheck } from "lucide-react";
import { Container } from "@/components/ui/container";
import { formatDateTime, formatMoney } from "@/lib/format";
import { getActiveCampaign, getWinner } from "@/server/storefront";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const winner = await getWinner(slug);
  return { title: `${winner.publicName} — ${winner.prize.name}`, description: `${winner.publicName} of ${winner.publicLocation} won ${winner.prize.name}.`, alternates: { canonical: `/winners/${winner.slug}` } };
}

export default async function WinnerDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [winner, currentCampaign] = await Promise.all([getWinner(slug), getActiveCampaign()]);
  return (
    <main className="public-page">
      <Container className="breadcrumb-row"><Link href="/winners"><ArrowLeft aria-hidden="true" size={16} /> All winners</Link></Container>
      <article className="winner-story section">
        <Container className="winner-story-grid">
          <div className="winner-story-media">
            <Image src={winner.image ?? winner.prize.image ?? "/demo/winners/winner-1.svg"} alt={`${winner.publicName}, verified giveaway winner`} fill loading="eager" sizes="(max-width: 900px) 100vw, 55vw" />
            <span>{winner.campaign.code}</span>
          </div>
          <div className="winner-story-copy">
            <p className="eyebrow"><BadgeCheck aria-hidden="true" /> Verified winner</p>
            <h1>{winner.publicName}</h1>
            <p className="winner-location"><MapPin aria-hidden="true" size={18} /> {winner.publicLocation}</p>
            <h2>Won {winner.prize.name}</h2>
            {winner.quote ? <blockquote>“{winner.quote}”</blockquote> : null}
            <dl>
              <div><dt>Campaign</dt><dd>{winner.campaign.title}</dd></div>
              <div><dt>Prize ARV</dt><dd>{formatMoney(winner.prize.approximateValueCents, winner.prize.currency)}</dd></div>
              <div><dt>Verified</dt><dd>{winner.verifiedAt ? formatDateTime(winner.verifiedAt, winner.campaign.timezone) : "Complete"}</dd></div>
            </dl>
            <p className="verified-note"><ShieldCheck aria-hidden="true" /> Published only after identity and eligibility verification.</p>
          </div>
        </Container>
      </article>
      <section className="winner-next-cta">
        <Container><p className="eyebrow">The next drawing is open</p><h2>Meet the current prize.</h2><p>No purchase necessary. Eligibility restrictions apply.</p><div className="button-row"><Link className="button button-accent" href={`/giveaways/${currentCampaign.slug}`}>View giveaway</Link><Link className="button button-glass" href={`/giveaways/${currentCampaign.slug}/free-entry`}>Free entry</Link></div></Container>
      </section>
    </main>
  );
}
