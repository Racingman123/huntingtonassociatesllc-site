import type { Metadata } from "next";
import Link from "next/link";
import { BadgeCheck, Calculator, CheckCircle2, FileLock2, Gift, PackageCheck, RefreshCcw, ShieldCheck, TicketCheck } from "lucide-react";
import { Container } from "@/components/ui/container";
import { Disclosure } from "@/components/storefront/disclosure";
import { PageHero } from "@/components/storefront/page-hero";
import { SectionHeading } from "@/components/storefront/section-heading";
import { formatEntries, formatMoney } from "@/lib/format";
import { calculateStorefrontEntryQuote } from "@/lib/purchase-entry-rules";
import { getActiveCampaign, getAllProducts, getCampaign, getTenant } from "@/server/storefront";
import { assertCampaignOfficialRules, officialRulesHref } from "@/lib/official-rules";
import { campaignAvailability } from "@/server/campaigns/availability";
import { createStorefrontEntryQuoteLookup } from "@/server/commerce/storefront-quotes";

export const metadata: Metadata = {
  title: "How It Works",
  description: "See how purchase and free sweepstakes entries are calculated, recorded, reconciled, and randomly drawn.",
  alternates: { canonical: "/how-it-works" },
};

export default async function HowItWorksPage() {
  const [activeCampaign, products, tenant] = await Promise.all([getActiveCampaign(), getAllProducts(), getTenant()]);
  const campaign = await getCampaign(activeCampaign.slug);
  const freeRule = campaign.entryRules.find((rule) => rule.targetType === "FREE_ENTRY");
  const rulesHref = officialRulesHref(assertCampaignOfficialRules(campaign));
  const availability = campaignAvailability(campaign);
  const exampleProduct = products.find((product) => product.variants.length > 0) ?? null;
  const exampleVariant = exampleProduct?.variants[0] ?? null;
  const exampleQuote = availability.purchaseEntryOpen && exampleProduct && exampleVariant
    ? createStorefrontEntryQuoteLookup(campaign, [exampleProduct])[exampleVariant.id]
    : null;
  const exampleCalculation = exampleQuote ? calculateStorefrontEntryQuote(exampleQuote, 1) : null;
  return (
    <main className="public-page">
      <PageHero eyebrow="Transparent by design" title="Every entry has a paper trail." description="Choose either entry method. The system records the source, math, rules version, and timestamp before every eligible entry reaches one shared drawing pool." tone="dark">
        <div className="how-hero-badge"><ShieldCheck aria-hidden="true" /><strong>No purchase necessary</strong><span>A purchase will not increase the chance attached to any individual entry.</span></div>
      </PageHero>
      <Disclosure text={campaign.noPurchaseDisclosure} campaignSlug={campaign.slug} officialRulesHref={rulesHref} />

      <section className="section">
        <Container>
          <SectionHeading eyebrow="Start here" title="Pick the path that works for you." />
          <div className="how-entry-cards">
            <article>
              <span className="method-label">Path 01</span><PackageCheck aria-hidden="true" /><h2>Shop qualifying products</h2>
              <p>Choose real merchandise at the displayed price. Product pages and the cart show a live entry quote before you pay.</p>
              <ul><li><CheckCircle2 aria-hidden="true" /> Entries post after payment confirmation</li><li><CheckCircle2 aria-hidden="true" /> Tax and shipping never earn entries</li><li><CheckCircle2 aria-hidden="true" /> Refund consequences are disclosed before checkout</li></ul>
              <Link className="button button-primary" href="/shop">Shop the current drop</Link>
            </article>
            <article className="how-entry-card-free">
              <span className="method-label">Path 02</span><TicketCheck aria-hidden="true" /><h2>Enter online for free</h2>
              <p>Complete the alternate method of entry with no purchase and no required marketing opt-in. Each valid submission requests {formatEntries(freeRule?.baseEntries ?? 25_000n)} entries.</p>
              <ul><li><CheckCircle2 aria-hidden="true" /> Direct, online, and accessible</li><li><CheckCircle2 aria-hidden="true" /> Same prize and shared entry cap</li><li><CheckCircle2 aria-hidden="true" /> Same random drawing pool</li></ul>
              <Link className="button button-accent" href={`/giveaways/${campaign.slug}/free-entry`}>Use the free entry method</Link>
            </article>
          </div>
        </Container>
      </section>

      <section className="section section-dark">
        <Container>
          <SectionHeading eyebrow="Purchase entry math" title="The number shown is the number recorded." inverse />
          {exampleQuote && exampleCalculation && exampleProduct ? <div className="math-example">
            <div><small>{exampleProduct.title}</small><strong>{formatMoney(exampleQuote.unitPriceCents, tenant.currency)}</strong></div><span>×</span>
            <div><small>Base entries per whole unit</small><strong>{campaign.baseEntriesPerDollar}</strong></div><span>×</span>
            <div><small>Published effective multiplier</small><strong>{exampleQuote.effectiveMultiplier}X</strong></div><span>=</span>
            <div className="math-total"><small>Entry quote</small><strong>{formatEntries(exampleCalculation.finalEntries)}</strong></div>
          </div> : <p className="form-alert">Purchase-entry math is unavailable because the purchase-entry period is not open.</p>}
          <div className="math-rules"><Calculator aria-hidden="true" /><p>Discounts reduce the qualifying amount. The calculation rounds down to whole currency units per line. Product-specific boosts are clearly labeled and multiply the live campaign rate.</p></div>
        </Container>
      </section>

      <section className="section integrity-process">
        <Container>
          <SectionHeading eyebrow="After entry closes" title="From ledger to winner." description="The campaign configuration is frozen before launch. Every later action leaves an audit record." />
          <ol>
            <li><span>01</span><FileLock2 aria-hidden="true" /><div><h3>Reconcile and seal</h3><p>Payments, refunds, free submissions, eligibility reviews, and the ledger high-water mark are reconciled into a checksum-protected snapshot.</p></div></li>
            <li><span>02</span><Gift aria-hidden="true" /><div><h3>Randomly select</h3><p>The approved drawing procedure selects an entry from the sealed eligible range. The operator, witness, provider, and result checksum are recorded.</p></div></li>
            <li><span>03</span><BadgeCheck aria-hidden="true" /><div><h3>Verify the potential winner</h3><p>Selection is provisional until identity, age, residence, exclusions, and required documents are verified under the Official Rules.</p></div></li>
            <li><span>04</span><RefreshCcw aria-hidden="true" /><div><h3>Use an alternate if needed</h3><p>If the selected entrant is ineligible, declines, or misses the response deadline, an ordered alternate may be contacted. The sponsor never hand-picks a replacement.</p></div></li>
          </ol>
        </Container>
      </section>

      <section className="rules-cta"><Container><div><p className="eyebrow">The rules control</p><h2>Read them before you enter.</h2><p>Dates, eligibility, frequency, caps, prize restrictions, odds, and claim requirements live in the campaign’s Official Rules.</p></div><Link className="button button-light" href={rulesHref}>Read Official Rules</Link></Container></section>
    </main>
  );
}
