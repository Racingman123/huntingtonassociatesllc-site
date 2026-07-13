import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertCampaignOfficialRules, officialRulesHref } from "./official-rules";

const rules = {
  id: "rules-v1",
  tenantId: "tenant",
  kind: "OFFICIAL_RULES",
  slug: "official-rules",
  title: "Official Rules",
  version: 1,
  body: "NO PURCHASE NECESSARY.",
  checksum: createHash("sha256").update("NO PURCHASE NECESSARY.").digest("hex"),
  status: "PUBLISHED",
  effectiveAt: new Date("2027-01-01T00:00:00Z"),
};

describe("campaign Official Rules binding", () => {
  it("accepts and links only the exact bound published document", () => {
    const bound = assertCampaignOfficialRules({
      tenantId: "tenant",
      startsAt: new Date("2027-01-02T00:00:00Z"),
      rulesVersion: 1,
      officialRulesDocumentId: rules.id,
      officialRulesChecksum: rules.checksum,
      officialRulesDocument: rules,
    });
    expect(bound.id).toBe(rules.id);
    expect(officialRulesHref(bound)).toBe("/policies/official-rules/versions/1");
  });

  it("fails closed for a missing or checksum-mismatched binding", () => {
    expect(() => assertCampaignOfficialRules({
      tenantId: "tenant",
      startsAt: new Date("2027-01-02T00:00:00Z"),
      rulesVersion: 1,
      officialRulesDocumentId: null,
      officialRulesChecksum: null,
      officialRulesDocument: null,
    })).toThrow(/exact published Official Rules/);
    expect(() => assertCampaignOfficialRules({
      tenantId: "tenant",
      startsAt: new Date("2027-01-02T00:00:00Z"),
      rulesVersion: 1,
      officialRulesDocumentId: rules.id,
      officialRulesChecksum: "b".repeat(64),
      officialRulesDocument: rules,
    })).toThrow(/exact published Official Rules/);
    expect(() => assertCampaignOfficialRules({
      tenantId: "tenant",
      startsAt: new Date("2027-01-02T00:00:00Z"),
      rulesVersion: 1,
      officialRulesDocumentId: rules.id,
      officialRulesChecksum: rules.checksum,
      officialRulesDocument: { ...rules, body: `${rules.body} tampered` },
    })).toThrow(/exact published Official Rules/);
  });
});
