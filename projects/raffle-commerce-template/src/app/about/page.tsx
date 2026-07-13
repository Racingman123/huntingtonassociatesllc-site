import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { BadgeCheck, Compass, HeartHandshake, Mountain, Scale, ShieldCheck } from "lucide-react";
import { Container } from "@/components/ui/container";
import { PageHero } from "@/components/storefront/page-hero";
import { SectionHeading } from "@/components/storefront/section-heading";
import { getActiveCampaign, getPublishedWinners, getTenant } from "@/server/storefront";

export const metadata: Metadata = {
  title: "About",
  description: "Meet the product-minded team and transparent principles behind this giveaway storefront.",
  alternates: { canonical: "/about" },
};

export default async function AboutPage() {
  const [tenant, winners, campaign] = await Promise.all([getTenant(), getPublishedWinners(), getActiveCampaign()]);
  return (
    <main className="public-page">
      <PageHero eyebrow="Our story" title="Built for the detour." description={`${tenant.displayName} starts with a stubborn belief: the products should be worth buying even when there is no prize attached—and every promotion should be easy to understand.`} tone="dark" />
      <section className="about-story section">
        <Container>
          <div className="about-story-image"><Image src="/demo/giveaway/story-camp.svg" alt="A basecamp beneath a night sky" fill loading="eager" sizes="(max-width: 900px) 100vw, 50vw" /></div>
          <div className="about-story-copy"><p className="eyebrow">{tenant.displayName}, not a shortcut</p><h2>Gear for getting out there. Systems for doing it right.</h2><p>We build practical trail, roadside, and everyday-carry products around the moments when preparation matters. Giveaways are how we turn that community energy into an outsized adventure for one randomly selected, verified entrant.</p><p>The sweepstakes side is intentionally less glamorous: frozen campaign terms, versioned rules, explicit entry calculations, immutable ledger events, controlled refunds, sealed snapshots, and a verifiable drawing trail. That quiet machinery is the point.</p><Link className="text-link" href="/how-it-works">See how the system works</Link></div>
        </Container>
      </section>

      <section className="section section-surface">
        <Container>
          <SectionHeading eyebrow="What guides us" title="Useful. Fair. Plainspoken." />
          <div className="values-grid">
            <article><Mountain aria-hidden="true" /><span>01</span><h3>Product before promotion</h3><p>No empty transaction. Every item is designed to deliver value on its own, regardless of the drawing outcome.</p></article>
            <article><Scale aria-hidden="true" /><span>02</span><h3>Equal access</h3><p>The direct free method is prominent, online, and capable of reaching the same campaign cap as purchase entry.</p></article>
            <article><ShieldCheck aria-hidden="true" /><span>03</span><h3>Traceable decisions</h3><p>Approvals, entry changes, reviews, refunds, snapshots, and drawing events are recorded for accountable administration.</p></article>
            <article><Compass aria-hidden="true" /><span>04</span><h3>Clarity over hype</h3><p>Big prizes can still come with exact dates, realistic odds language, visible restrictions, and honest winner communication.</p></article>
          </div>
        </Container>
      </section>

      <section className="about-proof section section-dark">
        <Container>
          <div><p className="eyebrow">Demonstration archive</p><strong>{winners.length}</strong><span>published winner stories</span></div>
          <div><BadgeCheck aria-hidden="true" /><h2>Proof belongs in the product.</h2><p>A giveaway platform should make its integrity inspectable: customers can see their entry balance, administrators can reconcile every change, and the public sees only winners who completed verification.</p><Link className="button button-light" href="/winners">Meet past winners</Link></div>
        </Container>
      </section>

      <section className="community-cta">
        <Container><HeartHandshake aria-hidden="true" /><div><p className="eyebrow">Come as you are</p><h2>There is room around the fire.</h2><p>Shop a piece of gear, enter free, join Basecamp, or simply follow the next build. Participation never requires a purchase.</p></div><Link className="button button-primary" href={`/giveaways/${campaign.slug}`}>Explore the current giveaway</Link></Container>
      </section>
      <section className="template-note"><Container><p><strong>Implementation note:</strong> {tenant.displayName} is the original demonstration brand included with this reusable platform template. Replace all sample company, prize, legal, product, and campaign content—and obtain qualified legal review—before a production promotion.</p></Container></section>
    </main>
  );
}
