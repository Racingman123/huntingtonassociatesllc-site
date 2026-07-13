import { createHash } from "node:crypto";

export type BoundOfficialRules = {
  id: string;
  tenantId: string;
  kind: string;
  slug: string;
  title: string;
  version: number;
  body: string;
  checksum: string;
  status: string;
  effectiveAt: Date | null;
};

export type CampaignRulesBinding = {
  tenantId: string;
  startsAt: Date;
  rulesVersion: number;
  officialRulesDocumentId: string | null;
  officialRulesChecksum: string | null;
  officialRulesDocument?: BoundOfficialRules | null;
};

export type OfficialRulesHref = `/policies/${string}/versions/${number}`;

/**
 * Verifies the immutable campaign-to-document binding. This deliberately does
 * not fall back to the latest document: entry mutations must stop if the
 * campaign's exact published rules cannot be proven.
 */
export function assertCampaignOfficialRules<T extends CampaignRulesBinding>(campaign: T) {
  const rules = campaign.officialRulesDocument;
  const bodyChecksum = rules
    ? createHash("sha256").update(rules.body).digest("hex")
    : null;
  if (
    !campaign.officialRulesDocumentId
    || !campaign.officialRulesChecksum
    || !rules
    || rules.id !== campaign.officialRulesDocumentId
    || rules.tenantId !== campaign.tenantId
    || rules.kind !== "OFFICIAL_RULES"
    || rules.status !== "PUBLISHED"
    || rules.version !== campaign.rulesVersion
    || rules.checksum !== campaign.officialRulesChecksum
    || bodyChecksum !== rules.checksum
    || !rules.effectiveAt
    || rules.effectiveAt > campaign.startsAt
  ) {
    throw new Error("The campaign's exact published Official Rules are unavailable");
  }
  return rules;
}

export function officialRulesHref(
  rules: Pick<BoundOfficialRules, "slug" | "version">,
): OfficialRulesHref {
  return `/policies/${encodeURIComponent(rules.slug)}/versions/${rules.version}`;
}
