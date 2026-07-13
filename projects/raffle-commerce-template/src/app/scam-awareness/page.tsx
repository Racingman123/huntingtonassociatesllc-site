import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, BadgeCheck, Ban, CheckCircle2, Mail, MessageCircleWarning, Phone, ShieldAlert } from "lucide-react";
import { Container } from "@/components/ui/container";
import { PageHero } from "@/components/storefront/page-hero";
import { SectionHeading } from "@/components/storefront/section-heading";
import { getActiveCampaign, getTenant } from "@/server/storefront";
import { assertCampaignOfficialRules, officialRulesHref } from "@/lib/official-rules";

export const metadata: Metadata = {
  title: "Scam Awareness",
  description: "Learn how potential winners are contacted, what a legitimate sponsor will never ask for, and how to report an impersonation scam.",
  alternates: { canonical: "/scam-awareness" },
};

export default async function ScamAwarenessPage() {
  const [tenant, campaign] = await Promise.all([getTenant(), getActiveCampaign()]);
  const rulesHref = officialRulesHref(assertCampaignOfficialRules(campaign));
  return (
    <main className="public-page">
      <PageHero eyebrow="Winner safety" title="A prize should never cost you your security." description="Impersonators copy logos, create fake social accounts, and pressure people to act fast. Slow down and verify every winner communication." tone="accent">
        <ShieldAlert aria-hidden="true" className="scam-hero-icon" />
      </PageHero>
      <section className="scam-alert"><Container><AlertTriangle aria-hidden="true" /><p><strong>{tenant.displayName} will never ask you to pay a fee, buy gift cards, send cryptocurrency, or share online-banking credentials to claim a prize.</strong></p></Container></section>

      <section className="section">
        <Container>
          <SectionHeading eyebrow="Red flags" title="Stop when a message asks for this." />
          <div className="red-flag-grid">
            <article><Ban aria-hidden="true" /><h3>Payment to release a prize</h3><p>Taxes, transport, “processing,” or insurance demanded through a wire, gift card, cash app, or cryptocurrency.</p></article>
            <article><MessageCircleWarning aria-hidden="true" /><h3>A social-media-only claim</h3><p>An unsolicited direct message saying you won, especially from a new, private, misspelled, or unverified account.</p></article>
            <article><ShieldAlert aria-hidden="true" /><h3>Credentials or remote access</h3><p>Requests for a password, one-time code, complete payment-card number, bank login, or remote-control software.</p></article>
            <article><AlertTriangle aria-hidden="true" /><h3>Urgency and secrecy</h3><p>Threats that the prize disappears in minutes, instructions not to tell anyone, or pressure to skip independent verification.</p></article>
          </div>
        </Container>
      </section>

      <section className="section section-dark safe-contact">
        <Container>
          <SectionHeading eyebrow="What legitimate contact looks like" title="Verify first. Respond second." inverse />
          <ol>
            <li><span><Mail aria-hidden="true" /></span><div><h3>Contact uses your entry information</h3><p>A potential winner is contacted using the email and telephone information supplied during entry—not a social profile discovered later.</p></div></li>
            <li><span><BadgeCheck aria-hidden="true" /></span><div><h3>Selection is provisional</h3><p>The communication explains the campaign, administrator, verification steps, response deadline, and that eligibility must be confirmed.</p></div></li>
            <li><span><Phone aria-hidden="true" /></span><div><h3>You can independently confirm</h3><p>Do not use only the reply address or phone number in a suspicious message. Start from this website and contact {tenant.supportEmail}.</p></div></li>
            <li><span><CheckCircle2 aria-hidden="true" /></span><div><h3>Sensitive documents use a secure claim flow</h3><p>Tax and identity documents are requested only from a provisional winner through the approved claim process—never through a social DM.</p></div></li>
          </ol>
        </Container>
      </section>

      <section className="section report-scam">
        <Container>
          <div><p className="eyebrow">Received something suspicious?</p><h2>Don’t pay. Don’t click. Preserve the evidence.</h2><p>Take screenshots, copy the profile URL, preserve email headers, and contact support from the address published on this site. You can also report the account to the platform and the appropriate consumer-protection authority.</p></div>
          <div className="report-card"><Mail aria-hidden="true" /><small>Official support</small><a href={`mailto:${tenant.supportEmail}`}>{tenant.supportEmail}</a><p>Never send passwords, one-time codes, banking credentials, or unrequested identity documents.</p></div>
        </Container>
      </section>
      <section className="template-note"><Container><p>For the exact winner selection and notification process, review the <Link href={rulesHref}>Official Rules</Link>. Only the rules for the named campaign control.</p></Container></section>
    </main>
  );
}
