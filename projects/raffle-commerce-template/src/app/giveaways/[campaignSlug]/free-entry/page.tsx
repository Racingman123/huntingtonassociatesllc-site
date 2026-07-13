import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FreeEntryForm } from "@/components/entries/free-entry-form";
import { getCampaign } from "@/server/storefront";
import { campaignAvailability } from "@/server/campaigns/availability";
import { campaignEligibilityOptions } from "@/server/campaigns/eligibility";
import { formatDateTime, formatEntries } from "@/lib/format";
import { assertCampaignOfficialRules, officialRulesHref } from "@/lib/official-rules";

export const metadata: Metadata = {
  title: "Free Entry",
  description: "Enter the current sweepstakes without making a purchase.",
};

export default async function FreeEntryPage({ params }: { params: Promise<{ campaignSlug: string }> }) {
  const { campaignSlug } = await params;
  const campaign = await getCampaign(campaignSlug);
  const freeRule = campaign.entryRules.find((rule) => rule.ruleType === "AMOE_FIXED");
  if (!freeRule) notFound();
  const availability = campaignAvailability(campaign);
  const eligibility = campaignEligibilityOptions(campaign);
  const rulesHref = officialRulesHref(assertCampaignOfficialRules(campaign));
  return (
    <main className="page-shell free-entry-page">
      <section className="free-entry-intro">
        <p className="eyebrow">ALTERNATIVE METHOD OF ENTRY</p>
        <h1>Enter free.</h1>
        <p className="lede">No order, payment, donation, app download, referral, survey, or marketing opt-in is required.</p>
        <div className="free-entry-facts">
          <div><span>Each valid submission</span><strong>{formatEntries(freeRule.baseEntries)} entries</strong></div>
          <div><span>Free entry closes</span><strong>{formatDateTime(campaign.freeEntryEndsAt, campaign.timezone)}</strong></div>
          <div><span>Entry cap</span><strong>{campaign.maxEntriesPerEntrant ? formatEntries(campaign.maxEntriesPerEntrant) : "See rules"}</strong></div>
        </div>
        <div className="disclosure-panel">
          <strong>{campaign.noPurchaseDisclosure}</strong>
          <p>Free and purchase entries go into the same drawing and have the same chance per entry. Email-based intake and documented identity review apply the shared cap in the Official Rules.</p>
        </div>
        <p>{campaign.eligibilitySummary}</p>
        <p><Link href={`/giveaways/${campaign.slug}`}>View the prize</Link> · <Link href={rulesHref}>Read Official Rules</Link></p>
      </section>
      <section className="free-entry-card" aria-labelledby="free-entry-form-heading">
        <p className="eyebrow">DIRECT ENTRY FORM</p>
        <h2 id="free-entry-form-heading">{availability.freeEntryOpen ? "Your entry details" : availability.publicState === "UPCOMING" ? "Entry has not opened" : "Entry is closed"}</h2>
        {availability.freeEntryOpen ? (
          <FreeEntryForm campaignSlug={campaign.slug} awardEntries={freeRule.baseEntries} minimumAge={campaign.minimumAge} eligibleCountries={eligibility.countries} officialRulesHref={rulesHref} />
        ) : (
          <div className="empty-state">
            <p>{availability.publicState === "UPCOMING"
              ? `The no-purchase entry period opens ${formatDateTime(campaign.startsAt, campaign.timezone)}.`
              : "The no-purchase entry deadline has passed. Existing entries remain in the same reconciliation and drawing process."}</p>
            <div className="button-row">
              <Link className="button button-primary" href={`/giveaways/${campaign.slug}`}>Promotion details</Link>
              <Link className="button button-secondary" href="/winners">Winner updates</Link>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
