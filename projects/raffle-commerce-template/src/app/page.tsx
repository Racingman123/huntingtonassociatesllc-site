import Image from "next/image";
import Link from "next/link";
import { ArrowRight, BadgeCheck, Gift, PackageCheck, ShieldCheck, Sparkles } from "lucide-react";
import { ButtonLink } from "@/components/ui/button-link";
import { Container } from "@/components/ui/container";
import { CampaignHero } from "@/components/storefront/campaign-hero";
import { CollectionCard } from "@/components/storefront/collection-card";
import { Disclosure } from "@/components/storefront/disclosure";
import { FaqList } from "@/components/storefront/faq-list";
import { ProductGrid } from "@/components/storefront/product-grid";
import { SectionHeading } from "@/components/storefront/section-heading";
import { WinnerCard } from "@/components/storefront/winner-card";
import { getHomeData } from "@/server/storefront";
import { campaignAvailability } from "@/server/campaigns/availability";
import { formatMoney } from "@/lib/format";
import { assertCampaignOfficialRules, officialRulesHref } from "@/lib/official-rules";
import { createStorefrontEntryQuoteLookup } from "@/server/commerce/storefront-quotes";

export default async function HomePage() {
  const { campaign, products, collections, winners, theme, tenant } = await getHomeData();
  const quickEntry = products.filter((product) => product.category === "Quick Entry");
  const featured = products.filter((product) => product.category !== "Quick Entry").slice(0, 8);
  const availability = campaignAvailability(campaign);
  const rulesHref = officialRulesHref(assertCampaignOfficialRules(campaign));
  const entryQuotes = availability.purchaseEntryOpen
    ? createStorefrontEntryQuoteLookup(campaign, products)
    : {};
  const effectiveRates = Object.values(entryQuotes).map((quote) => quote.effectiveMultiplier);
  const rateRange = effectiveRates.length
    ? `${Math.min(...effectiveRates)}X${Math.max(...effectiveRates) === Math.min(...effectiveRates) ? "" : `–${Math.max(...effectiveRates)}X`}`
    : null;

  return (
    <main className="public-page">
      <CampaignHero campaign={campaign} />
      <Disclosure text={campaign.noPurchaseDisclosure} campaignSlug={campaign.slug} officialRulesHref={rulesHref} />

      <section className="home-intro-band">
        <Container>
          <p><Sparkles aria-hidden="true" size={18} /> {availability.purchaseEntryOpen ? "Right now, qualifying orders earn" : "Promotion status"}</p>
          <strong>{availability.purchaseEntryOpen ? rateRange ?? "Published quotes" : availability.publicState === "UPCOMING" ? "Opening soon" : "Entry closed"}</strong>
          <span>{availability.purchaseEntryOpen ? "Exact published effective rate varies by product option" : availability.publicState === "UPCOMING" ? "Review the promotion details and opening time" : "Existing entries are being reconciled for the drawing"}</span>
        </Container>
      </section>

      <section id="featured-products" className="section section-surface">
        <Container>
          <SectionHeading
            eyebrow="Quick & easy"
            title="Short on time? Start here."
            description="Digital supporter packs are real products with a separately shown entry quote. A live deployment connects its own digital fulfillment provider."
            href="/collections/quick-entry"
            linkLabel="All quick entry packs"
          />
          <ProductGrid products={quickEntry} entryQuotes={entryQuotes} entriesAvailable={availability.purchaseEntryOpen} currency={tenant.currency} />
        </Container>
      </section>

      <section className="section">
        <Container>
          <SectionHeading
            eyebrow="Just in"
            title="New gear for wherever you’re headed."
            href="/collections/new-releases"
            linkLabel="Shop new releases"
          />
          <ProductGrid products={featured} entryQuotes={entryQuotes} entriesAvailable={availability.purchaseEntryOpen} currency={tenant.currency} />
        </Container>
      </section>

      <section className="campaign-feature">
        <div className="campaign-feature-image">
          <Image src={campaign.prizes[0]?.image ?? "/demo/giveaway/hero-rig.svg"} alt="Adventure rig parked beside an alpine lake" fill loading="eager" fetchPriority="high" sizes="(max-width: 900px) 100vw, 56vw" />
        </div>
        <div className="campaign-feature-copy">
          <p className="eyebrow">One winner. One wild upgrade.</p>
          <h2>This could be your next driveway.</h2>
          <p>{campaign.longDescription}</p>
          <div className="campaign-feature-points">
            <span><BadgeCheck aria-hidden="true" /> Independent, documented drawing</span>
            <span><Gift aria-hidden="true" /> Vehicle, camper, gear, and cash</span>
            <span><ShieldCheck aria-hidden="true" /> Free and purchase entries share one pool</span>
          </div>
          <div className="button-row">
            <ButtonLink href={`/giveaways/${campaign.slug}`} variant="light" arrow>See all prize details</ButtonLink>
            {availability.freeEntryOpen ? <ButtonLink href={`/giveaways/${campaign.slug}/free-entry`} variant="ghost">Enter without purchase</ButtonLink> : null}
          </div>
          <p className="fine-print">{campaign.noPurchaseDisclosure}</p>
        </div>
      </section>

      <section className="section section-surface">
        <Container>
          <SectionHeading eyebrow="Find your lane" title="Shop by category." href="/shop" linkLabel="Browse the full shop" />
          <div className="collection-grid">
            {collections.map((collection, index) => <CollectionCard key={collection.id} collection={collection} index={index} />)}
          </div>
        </Container>
      </section>

      <section className="section how-strip">
        <Container>
          <SectionHeading eyebrow="The simple version" title="Gear up. Get entered. Stay ready." href="/how-it-works" linkLabel="Learn how it works" />
          <ol className="steps-grid">
            <li><span>01</span><PackageCheck aria-hidden="true" /><h3>Choose your route</h3><p>Buy gear you actually want or use the no-purchase-necessary entry form.</p></li>
            <li><span>02</span><Sparkles aria-hidden="true" /><h3>Entries are recorded</h3><p>Purchase entry totals are quoted before checkout. Valid free entries join the same pool.</p></li>
            <li><span>03</span><BadgeCheck aria-hidden="true" /><h3>A winner is drawn</h3><p>After reconciliation, an independent process randomly selects and verifies a potential winner.</p></li>
          </ol>
        </Container>
      </section>

      {winners.length ? (
        <section className="section winners-home">
          <Container>
            <SectionHeading
              eyebrow="Real people. Real prizes."
              title="The next story could be yours."
              description="Every published winner has completed eligibility verification before appearing here."
              href="/winners"
              linkLabel="Meet all winners"
              inverse
            />
            <div className="winner-home-grid">
              {winners.map((winner, index) => <WinnerCard key={winner.id} winner={winner} featured={index === 0} />)}
            </div>
          </Container>
        </section>
      ) : null}

      <section className="impact-band">
        <Container>
          <div><strong>100%</strong><span>documented entry ledger</span></div>
          <div><strong>2</strong><span>equal ways to enter</span></div>
          <div><strong>1</strong><span>shared random drawing</span></div>
          <div><strong>{formatMoney(0, tenant.currency)}</strong><span>required to participate</span></div>
        </Container>
      </section>

      <section className="section">
        <Container>
          <div className="editorial-cards">
            <Link className="editorial-card editorial-card-scam" href="/scam-awareness">
              <span className="eyebrow">Protect yourself</span>
              <strong>We never ask winners to pay to claim a prize.</strong>
              <span>Spot giveaway scams <ArrowRight aria-hidden="true" size={18} /></span>
            </Link>
            <Link className="editorial-card editorial-card-member" href="/membership">
              <span className="eyebrow">Basecamp members</span>
              <strong>Monthly gear credit. Member-only perks. No lock-in.</strong>
              <span>Explore membership <ArrowRight aria-hidden="true" size={18} /></span>
            </Link>
          </div>
        </Container>
      </section>

      <section className="section faq-section">
        <Container>
          <SectionHeading eyebrow="Good questions" title="Straight answers." />
          <FaqList items={[
            {
              question: "Do I have to buy something to enter?",
              answer: <p>No. The online free-entry method requires no purchase and no marketing consent. Each valid submission receives the entry amount stated in the Official Rules and joins the same drawing pool.</p>,
            },
            {
              question: "How are purchase entries calculated?",
              answer: <p>Qualifying whole currency units after discounts and before tax and shipping are multiplied by the product and campaign rates shown. Your exact entry quote appears on the product page, in your cart, and before checkout.</p>,
            },
            {
              question: "How is the winner chosen?",
              answer: <p>After entries close, the eligible ledger is reconciled and sealed. A random drawing is then conducted using that snapshot. The selected entrant is verified before being announced.</p>,
            },
            {
              question: `How will ${theme.brand.displayName} contact a potential winner?`,
              answer: <p>Using the email and telephone information supplied at entry—not through an unsolicited social-media direct message. We never require payment, gift cards, or banking credentials to release a prize.</p>,
            },
          ]} />
          <div className="faq-cta">
            <span>Still wondering?</span>
            <Link className="text-link" href="/help">Visit the help center <ArrowRight aria-hidden="true" size={18} /></Link>
          </div>
        </Container>
      </section>
    </main>
  );
}
