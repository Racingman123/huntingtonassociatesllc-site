const usRegionNames: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

type CampaignEligibilityConfig = {
  minimumAge?: number;
  eligibleCountriesJson: string;
  eligibleRegionsJson: string;
  excludedRegionsJson: string;
};

function parseCodes(value: string, field: string, expression: RegExp) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Campaign ${field} is not valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length > 300) {
    throw new Error(`Campaign ${field} must be an array of at most 300 codes`);
  }
  const codes = parsed.map((item) => typeof item === "string" ? item.trim().toUpperCase() : "");
  if (codes.some((code) => !expression.test(code)) || new Set(codes).size !== codes.length) {
    throw new Error(`Campaign ${field} contains an invalid or duplicate code`);
  }
  return codes;
}

export function normalizeEligibilityLocation(country: string, region: string) {
  const normalizedCountry = country.trim().toUpperCase();
  const rawRegion = region.trim();
  const normalizedRegion = normalizedCountry === "US"
    ? usRegionNames[rawRegion.toLowerCase()] ?? rawRegion.toUpperCase().replaceAll(".", "")
    : rawRegion.toUpperCase();
  return { country: normalizedCountry, region: normalizedRegion };
}

export function evaluateCampaignLocationEligibility(
  campaign: CampaignEligibilityConfig,
  location: { country: string; region: string },
) {
  if (
    campaign.minimumAge !== undefined
    && (!Number.isSafeInteger(campaign.minimumAge) || campaign.minimumAge < 18 || campaign.minimumAge > 120)
  ) {
    throw new Error("Campaign minimumAge must be an integer from 18 to 120");
  }
  const normalized = normalizeEligibilityLocation(location.country, location.region);
  const countries = parseCodes(campaign.eligibleCountriesJson, "eligibleCountriesJson", /^[A-Z]{2}$/);
  const includedRegions = parseCodes(campaign.eligibleRegionsJson, "eligibleRegionsJson", /^(?:[A-Z]{2}-)?[A-Z0-9]{1,10}$/);
  const excludedRegions = parseCodes(campaign.excludedRegionsJson, "excludedRegionsJson", /^(?:[A-Z]{2}-)?[A-Z0-9]{1,10}$/);
  if (countries.length === 0) throw new Error("Campaign must configure at least one eligible country");
  const regionKeys = new Set([normalized.region, `${normalized.country}-${normalized.region}`]);
  const countryAllowed = countries.includes(normalized.country);
  const explicitlyIncluded = includedRegions.length === 0
    || includedRegions.some((code) => regionKeys.has(code));
  const explicitlyExcluded = excludedRegions.some((code) => regionKeys.has(code));
  return {
    eligible: countryAllowed && explicitlyIncluded && !explicitlyExcluded,
    normalizedCountry: normalized.country,
    normalizedRegion: normalized.region,
  };
}

export function campaignEligibilityOptions(campaign: CampaignEligibilityConfig) {
  if (
    campaign.minimumAge !== undefined
    && (!Number.isSafeInteger(campaign.minimumAge) || campaign.minimumAge < 18 || campaign.minimumAge > 120)
  ) {
    throw new Error("Campaign minimumAge must be an integer from 18 to 120");
  }
  const countries = parseCodes(campaign.eligibleCountriesJson, "eligibleCountriesJson", /^[A-Z]{2}$/);
  if (countries.length === 0) throw new Error("Campaign must configure at least one eligible country");
  return {
    countries,
    includedRegions: parseCodes(campaign.eligibleRegionsJson, "eligibleRegionsJson", /^(?:[A-Z]{2}-)?[A-Z0-9]{1,10}$/),
    excludedRegions: parseCodes(campaign.excludedRegionsJson, "excludedRegionsJson", /^(?:[A-Z]{2}-)?[A-Z0-9]{1,10}$/),
  };
}

export function assertCampaignLocationEligible(
  campaign: CampaignEligibilityConfig,
  location: { country: string; region: string },
) {
  const result = evaluateCampaignLocationEligibility(campaign, location);
  if (!result.eligible) {
    throw new Error("This location is not eligible for the promotion");
  }
  return result;
}
