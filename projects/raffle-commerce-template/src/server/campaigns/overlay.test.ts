import { describe, expect, test } from "vitest";
import {
  campaignOverlayChecksum,
  entryWindowsOverlap,
  parseCampaignOverlay,
  publicationStatus,
  stableJson,
} from "./overlay";

function validOverlay() {
  const purchaseEntryRules: Array<{
    name: string;
    targetType: "ALL" | "CATEGORY" | "COLLECTION" | "PRODUCT" | "VARIANT";
    targetId: string | null;
    entriesPerCurrencyUnit: number;
    multiplierNumerator: number;
    multiplierDenominator: number;
    stackPriority: number;
    startsAt: string | null;
    endsAt: string | null;
    version: number;
    active: boolean;
  }> = [{
    name: "Standard merchandise",
    targetType: "ALL",
    targetId: null,
    entriesPerCurrencyUnit: 1,
    multiplierNumerator: 1,
    multiplierDenominator: 1,
    stackPriority: 0,
    startsAt: null,
    endsAt: null,
    version: 1,
    active: true,
  }];
  return {
    schemaVersion: 1,
    targetTenantSlug: "northstar",
    campaign: {
      slug: "summer-rig",
      code: "SUMMER-27",
      title: "Win the Summer Rig",
      eyebrow: "SUMMER GIVEAWAY",
      shortDescription: "A complete adventure package.",
      longDescription: "One verified winner receives the complete package described in the rules.",
      kind: "SWEEPSTAKES",
      currency: "USD",
      timezone: "America/New_York",
      windows: {
        startsAt: "2027-06-01T00:00:00-04:00",
        purchaseEndsAt: "2027-07-01T23:59:59-04:00",
        freeEntryEndsAt: "2027-07-03T23:59:59-04:00",
        drawAt: "2027-07-10T12:00:00-04:00",
      },
      baseEntriesPerCurrencyUnit: 1,
      maxEntriesPerEntrant: "1000000",
      noPurchaseDisclosure: "NO PURCHASE NECESSARY. A PURCHASE WILL NOT INCREASE YOUR CHANCES OF WINNING.",
      eligibilitySummary: "Open to eligible U.S. residents age 18 or older; void where prohibited.",
      eligibility: {
        minimumAge: 18,
        eligibleCountries: ["US"],
        eligibleRegions: ["CO", "NY"],
        excludedRegions: ["AK", "HI"],
      },
      officialRules: { version: 2, checksum: "a".repeat(64) },
      prizes: [{
        name: "Adventure Rig",
        description: "A fully configured adventure vehicle.",
        approximateValueCents: 12000000,
        currency: "USD",
        quantity: 1,
        cashAlternativeCents: null,
        image: "/brand/prizes/summer-rig.webp",
        sortOrder: 0,
      }],
      purchaseEntryRules,
      freeEntryRule: {
        name: "Online alternative method of entry",
        entriesPerSubmission: "25000",
        stackPriority: 100,
        startsAt: null,
        endsAt: null,
        version: 1,
        active: true,
      },
      multiplierSchedule: [
        { label: "Launch 20X", numerator: 20, denominator: 1, startsAt: "2027-06-01T00:00:00-04:00", endsAt: "2027-06-15T00:00:00-04:00" },
        { label: "Final 10X", numerator: 10, denominator: 1, startsAt: "2027-06-15T00:00:00-04:00", endsAt: "2027-07-01T23:59:59-04:00" },
      ],
      membershipEntryBands: [
        { planProductSlug: "basecamp-membership", minimumSettledCycles: 0, maximumSettledCycles: 2, fixedEntries: "25", multiplierNumerator: 1, multiplierDenominator: 1 },
        { planProductSlug: "basecamp-membership", minimumSettledCycles: 3, maximumSettledCycles: null, fixedEntries: "30", multiplierNumerator: 1, multiplierDenominator: 1 },
      ],
      operationalApprovals: [
        { kind: "LEGAL_RULES", evidenceRef: "demo://legal", notes: "Counsel approved the exact rules and release checksums." },
        { kind: "PRIZE_FUNDING", evidenceRef: "demo://prize", notes: "Sponsor documented prize funding and fulfillment capacity." },
        { kind: "AMOE_PARITY", evidenceRef: "demo://amoe", notes: "Counsel reviewed the free-entry burden and earning parity." },
        { kind: "DRAW_PROCEDURE", evidenceRef: "demo://draw", notes: "Compliance approved the snapshot and draw custody procedure." },
        { kind: "ACCESSIBILITY", evidenceRef: "demo://a11y", notes: "Accessibility testing and review evidence was approved." },
      ],
      filingDetermination: {
        mode: "REQUIREMENTS",
        requirements: [{
          jurisdiction: "FL",
          kind: "REGISTRATION_AND_BOND",
          triggerReason: "The announced prize value triggers a filing and security review.",
          dueAt: "2027-05-24T17:00:00-04:00",
          status: "COMPLETED",
          evidenceRef: "demo://filing",
          waiverRationale: null,
          completedAt: "2027-05-20T12:00:00-04:00",
        }],
      },
    },
  };
}

describe("campaign overlay validation", () => {
  test("accepts a complete promotion and creates a deterministic checksum", () => {
    const parsed = parseCampaignOverlay(validOverlay());
    expect(parsed.campaign.freeEntryRule.active).toBe(true);
    expect(campaignOverlayChecksum(parsed)).toMatch(/^[a-f0-9]{64}$/);
    expect(stableJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  test("rejects gaps, overlap, fractional multipliers, and an incomplete schedule", () => {
    const input = validOverlay();
    input.campaign.multiplierSchedule[0]!.denominator = 3;
    input.campaign.multiplierSchedule[1]!.startsAt = "2027-06-16T00:00:00-04:00";
    expect(() => parseCampaignOverlay(input)).toThrow(/integral|contiguous/i);
  });

  test("rejects unsafe prize assets and currency drift", () => {
    const input = validOverlay();
    input.campaign.prizes[0]!.image = "https://tracking.example/prize.jpg";
    input.campaign.prizes[0]!.currency = "EUR";
    expect(() => parseCampaignOverlay(input)).toThrow(/root-relative|currency/i);
  });

  test("rejects malformed eligibility, inactive AMOE, bad dates, and weak disclosure", () => {
    const input = validOverlay();
    input.campaign.eligibility.eligibleCountries = ["USA"];
    input.campaign.freeEntryRule.active = false;
    input.campaign.windows.drawAt = input.campaign.windows.purchaseEndsAt;
    input.campaign.noPurchaseDisclosure = "Purchase something to enter now.";
    expect(() => parseCampaignOverlay(input)).toThrow(/eligib|free-entry|draw|purchase/i);
  });

  test("rejects multiple prize units and potentially ambiguous purchase-rule priorities", () => {
    const input = validOverlay();
    input.campaign.prizes[0]!.quantity = 2;
    input.campaign.purchaseEntryRules.push({
      ...input.campaign.purchaseEntryRules[0]!,
      name: "Conflicting product boost",
      targetType: "PRODUCT",
      targetId: "trail-kit",
    });
    expect(() => parseCampaignOverlay(input)).toThrow(/exactly one prize|distinct priorities/i);
  });

  test("rejects incomplete membership bands and missing operational approval kinds", () => {
    const input = validOverlay();
    input.campaign.membershipEntryBands[1]!.minimumSettledCycles = 4;
    input.campaign.operationalApprovals[4]!.kind = "LEGAL_RULES";
    expect(() => parseCampaignOverlay(input)).toThrow(/contiguous|ACCESSIBILITY|exactly once/i);
  });

  test("requires filing evidence to be completed before campaign start", () => {
    const input = validOverlay();
    input.campaign.filingDetermination.requirements[0]!.completedAt = "2027-06-02T12:00:00-04:00";
    expect(() => parseCampaignOverlay(input)).toThrow(/completed no later than campaign start/i);
  });

  test("uses half-open windows and refuses already-ended publication", () => {
    const a = { startsAt: new Date("2027-01-01T00:00:00Z"), endsAt: new Date("2027-02-01T00:00:00Z") };
    const b = { startsAt: new Date("2027-02-01T00:00:00Z"), endsAt: new Date("2027-03-01T00:00:00Z") };
    expect(entryWindowsOverlap(a, b)).toBe(false);
    const parsed = parseCampaignOverlay(validOverlay());
    expect(publicationStatus(parsed, new Date("2027-05-01T00:00:00Z"))).toBe("SCHEDULED");
    expect(publicationStatus(parsed, new Date("2027-06-15T00:00:00Z"))).toBe("LIVE");
    expect(() => publicationStatus(parsed, new Date("2028-01-01T00:00:00Z"))).toThrow(/closed/i);
  });
});
