import { describe, expect, it } from "vitest";
import { legalBodyChecksum, legalReleaseChecksum, parseLegalRelease } from "./overlay";

function validRelease() {
  return {
    schemaVersion: 1,
    targetTenantSlug: "northstar",
    releaseName: "Summer rules release",
    documents: [{
      kind: "OFFICIAL_RULES",
      slug: "official-rules",
      title: "Official Rules",
      version: 2,
      effectiveAt: "2027-06-01T00:00:00-04:00",
      body: "NO PURCHASE NECESSARY. A PURCHASE WILL NOT INCREASE YOUR CHANCES OF WINNING. These are counsel-approved promotion-specific terms represented by a sufficiently long test fixture. Eligibility, entry methods, prize, odds, dates, verification, and general conditions belong here.",
    }],
  };
}

describe("legal release overlay", () => {
  it("parses a versioned release and checksums exact bodies deterministically", () => {
    const parsed = parseLegalRelease(validRelease());
    expect(legalBodyChecksum(parsed.documents[0]!.body)).toMatch(/^[a-f0-9]{64}$/);
    expect(legalReleaseChecksum(parsed)).toBe(legalReleaseChecksum(parseLegalRelease(validRelease())));
  });

  it("rejects duplicate versions and incomplete official rules", () => {
    const input = validRelease();
    input.documents.push({ ...input.documents[0]!, body: "This short document omits the mandatory promotion disclosures entirely." });
    expect(() => parseLegalRelease(input)).toThrow(/duplicate|purchase|100/i);
  });
});
