import { getActiveCampaign } from "@/server/storefront";
import { assertCampaignOfficialRules, officialRulesHref } from "@/lib/official-rules";

export async function GET() {
  const campaign = await getActiveCampaign();
  const rules = assertCampaignOfficialRules(campaign);
  return Response.json({
    data: [{
      slug: campaign.slug,
      code: campaign.code,
      title: campaign.title,
      shortDescription: campaign.shortDescription,
      status: campaign.status,
      startsAt: campaign.startsAt.toISOString(),
      endsAt: campaign.endsAt.toISOString(),
      freeEntryEndsAt: campaign.freeEntryEndsAt.toISOString(),
      timezone: campaign.timezone,
      currentMultiplier: campaign.currentMultiplier,
      entryCap: campaign.maxEntriesPerEntrant?.toString() ?? null,
      disclosure: campaign.noPurchaseDisclosure,
      eligibilitySummary: campaign.eligibilitySummary,
      rulesVersion: campaign.rulesVersion,
      officialRulesChecksum: rules.checksum,
      officialRulesHref: officialRulesHref(rules),
      prizes: campaign.prizes.map((prize) => ({
        name: prize.name,
        description: prize.description,
        approximateValueCents: prize.approximateValueCents,
        currency: prize.currency,
        quantity: prize.quantity,
        image: prize.image,
      })),
    }],
  }, { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } });
}
