import { describe, expect, it } from "vitest";
import { assertCampaignLocationEligible, evaluateCampaignLocationEligibility } from "./eligibility";

const campaign = {
  eligibleCountriesJson: '["US"]',
  eligibleRegionsJson: '["CO","DC","NY"]',
  excludedRegionsJson: '["AK","HI"]',
};

describe("structured campaign location eligibility", () => {
  it("normalizes full US state names and accepts configured regions", () => {
    expect(evaluateCampaignLocationEligibility(campaign, { country: "us", region: "Colorado" }))
      .toMatchObject({ eligible: true, normalizedCountry: "US", normalizedRegion: "CO" });
  });

  it("rejects non-configured and explicitly excluded regions", () => {
    expect(evaluateCampaignLocationEligibility(campaign, { country: "US", region: "California" }).eligible)
      .toBe(false);
    expect(() => assertCampaignLocationEligible(campaign, { country: "US", region: "AK" }))
      .toThrow(/not eligible/);
  });

  it("fails closed on malformed configuration", () => {
    expect(() => evaluateCampaignLocationEligibility({ ...campaign, eligibleRegionsJson: "not-json" }, { country: "US", region: "CO" }))
      .toThrow(/not valid JSON/);
    expect(() => evaluateCampaignLocationEligibility({ ...campaign, eligibleCountriesJson: "[]" }, { country: "US", region: "CO" }))
      .toThrow(/at least one/);
  });
});
