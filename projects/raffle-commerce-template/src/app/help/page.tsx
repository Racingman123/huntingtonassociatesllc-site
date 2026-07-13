import type { Metadata } from "next";
import Link from "next/link";
import { CircleHelp, Mail, Package, RefreshCcw, ShieldAlert, TicketCheck, UserRound } from "lucide-react";
import { Container } from "@/components/ui/container";
import { FaqList } from "@/components/storefront/faq-list";
import { SupportForm } from "@/components/forms/support-form";
import { PageHero } from "@/components/storefront/page-hero";
import { SectionHeading } from "@/components/storefront/section-heading";
import { getActiveCampaign, getTenant } from "@/server/storefront";
import { assertCampaignOfficialRules, officialRulesHref } from "@/lib/official-rules";

export const metadata: Metadata = {
  title: "Help Center",
  description: "Answers about giveaways, entries, orders, membership, returns, and winner communications.",
  alternates: { canonical: "/help" },
};

export default async function HelpPage() {
  const [tenant, campaign] = await Promise.all([getTenant(), getActiveCampaign()]);
  const rulesHref = officialRulesHref(assertCampaignOfficialRules(campaign));
  return (
    <main className="public-page">
      <PageHero eyebrow={`${tenant.displayName} support`} title="How can we help?" description="Clear answers about products, entries, orders, and what happens after a giveaway closes." tone="light">
        <a className="help-email" href={`mailto:${tenant.supportEmail}`}><Mail aria-hidden="true" /><span><small>Email support</small><strong>{tenant.supportEmail}</strong></span></a>
      </PageHero>
      <section className="section help-topics">
        <Container>
          <div className="help-topic-grid">
            <a href="#giveaway-questions"><TicketCheck aria-hidden="true" /><strong>Giveaways & entries</strong><span>Eligibility, calculations, and free entry</span></a>
            <a href="#order-questions"><Package aria-hidden="true" /><strong>Orders & shipping</strong><span>Confirmation, tracking, and delivery</span></a>
            <a href="#returns-questions"><RefreshCcw aria-hidden="true" /><strong>Returns</strong><span>Refunds and entry reversals</span></a>
            <Link href="/account"><UserRound aria-hidden="true" /><strong>My account</strong><span>Orders, entry balance, and profile</span></Link>
            <Link href="/scam-awareness"><ShieldAlert aria-hidden="true" /><strong>Winner safety</strong><span>Recognize and report scams</span></Link>
            <Link href={rulesHref}><CircleHelp aria-hidden="true" /><strong>Official Rules</strong><span>The controlling promotion terms</span></Link>
          </div>
        </Container>
      </section>

      <section id="giveaway-questions" className="section section-surface help-faq-block">
        <Container>
          <SectionHeading eyebrow="Giveaways & entries" title="Entering the right way." />
          <FaqList items={[
            { question: `Is ${tenant.displayName}'s giveaway real?`, answer: <p>This template demonstrates a complete sweepstakes system with a documented entry ledger, campaign freeze controls, a sealed drawing snapshot, random selection, and winner verification. Before a real launch, every promotion must be reviewed and administered under final counsel-approved rules.</p> },
            { question: "Can I enter without making a purchase?", answer: <p>Yes. Go directly to the <Link href={`/giveaways/${campaign.slug}/free-entry`}>free entry form</Link>. It requires no payment and marketing consent is optional. Frequency limits, eligibility, deadlines, and the shared cap are stated in the Official Rules.</p> },
            { question: "How do I know my purchase entries were recorded?", answer: <p>Your product page, cart, and checkout show an entry quote. Entries post only after payment confirmation and appear in your account ledger. Multiple qualifying orders are combined under the same eligible entrant and campaign.</p> },
            { question: "Why are entries based on whole currency units?", answer: <p>The campaign uses a line-level calculation on qualifying whole units after discounts and before tax and shipping. That rounding rule is applied consistently and stored with the order so future multiplier changes do not alter the original entry award.</p> },
            { question: "Do free and purchase entries have the same chance?", answer: <p>Every eligible entry is a unit in the same sealed drawing pool. Both methods are subject to the same identity-level cap and eligibility rules. Intake groups normalized email first; documented administrator review handles duplicate identities under the Official Rules.</p> },
          ]} />
        </Container>
      </section>

      <section id="order-questions" className="section help-faq-block">
        <Container>
          <SectionHeading eyebrow="Orders & fulfillment" title="From checkout to doorstep." />
          <FaqList items={[
            { question: "When will I receive an order confirmation?", answer: <p>A confirmation appears after successful payment and is also sent to the checkout email. If you do not see it, check spam and then contact support with your name, email, and approximate order time.</p> },
            { question: "How do digital supporter packs arrive?", answer: <p>A live store delivers the purchased files or access through its configured fulfillment provider after payment confirmation. The local template demo records fulfillment intent but does not deliver a real asset.</p> },
            { question: "How do I track a physical order?", answer: <p>A live fulfillment integration should add tracking to the order and send it to the checkout email when the carrier accepts the shipment. The local template demo does not create a real shipment.</p> },
          ]} />
        </Container>
      </section>

      <section id="returns-questions" className="section section-surface help-faq-block">
        <Container>
          <SectionHeading eyebrow="Returns & adjustments" title="Fair going in—and coming back." />
          <FaqList items={[
            { question: "What happens to entries after a refund?", answer: <p>Entries attributable to returned or refunded merchandise may be reversed as described in the Official Rules. The system uses the exact calculation stored with the original line item rather than today’s campaign multiplier.</p> },
            { question: "Can an entry balance go below zero?", answer: <p>The audit ledger preserves all grants and reversals. An account can reflect an adjustment when a refund, dispute, or chargeback reverses previously issued entries. Review the Official Rules and your account ledger for the controlling details.</p> },
          ]} />
        </Container>
      </section>

      <section className="support-cta">
        <Container><div className="support-cta-copy"><Mail aria-hidden="true" /><div><p className="eyebrow">Still need a hand?</p><h2>Talk to a real person.</h2><p>Include your order number or free-entry confirmation code when relevant. Never send sensitive identity or payment documents.</p></div></div><SupportForm /></Container>
      </section>
    </main>
  );
}
