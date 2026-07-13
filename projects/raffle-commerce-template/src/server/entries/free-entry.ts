import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "@/server/db";
import { assertCampaignLocationEligible } from "@/server/campaigns/eligibility";
import type { AuthenticatedEntrantIdentity } from "@/server/commerce/checkout";
import { phoneSchema } from "@/lib/phone";
import { assertCampaignOfficialRules } from "@/lib/official-rules";

export const freeEntrySchema = z.object({
  campaignSlug: z.string().trim().min(1).max(100),
  email: z.email().trim().toLowerCase(),
  name: z.string().trim().min(2).max(100),
  phone: phoneSchema,
  region: z.string().trim().min(2).max(40),
  postalCode: z.string().trim().min(3).max(16),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  ageConfirmed: z.literal(true),
  residenceConfirmed: z.literal(true),
  rulesAccepted: z.literal(true),
  website: z.string().max(0).optional(),
});

export type FreeEntryInput = z.infer<typeof freeEntrySchema>;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function localDateKey(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function confirmationCode() {
  return `FREE-${randomBytes(5).toString("hex").toUpperCase()}`;
}

export async function submitFreeEntry(
  rawInput: FreeEntryInput,
  tenantId: string,
  authenticatedIdentity?: AuthenticatedEntrantIdentity,
) {
  const input = freeEntrySchema.parse(rawInput);
  const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant || tenant.status !== "ACTIVE") throw new Error("This promotion is unavailable");
  const campaign = await db.campaign.findUnique({
    where: { tenantId_slug: { tenantId: tenant.id, slug: input.campaignSlug } },
    include: {
      entryRules: { where: { ruleType: "AMOE_FIXED", active: true }, orderBy: [{ stackPriority: "desc" }, { id: "asc" }] },
      officialRulesDocument: true,
    },
  });
  if (!campaign || !["LIVE", "ENTRY_CLOSED"].includes(campaign.status)) throw new Error("This promotion is unavailable");
  const now = new Date();
  if (now < campaign.startsAt || now >= campaign.freeEntryEndsAt) throw new Error("The free-entry period is closed");
  const officialRules = assertCampaignOfficialRules(campaign);
  const eligibleLocation = assertCampaignLocationEligible(campaign, {
    country: input.country,
    region: input.region,
  });
  const matchingFixedRules = campaign.entryRules.filter((rule) => (
    (!rule.startsAt || rule.startsAt <= now)
    && (!rule.endsAt || rule.endsAt > now)
  ));
  if (matchingFixedRules.length > 1 && matchingFixedRules[0]!.stackPriority === matchingFixedRules[1]!.stackPriority) {
    throw new Error("The free-entry method has ambiguous active rules");
  }
  const fixedRule = matchingFixedRules[0];
  if (!fixedRule || fixedRule.baseEntries <= 0n) throw new Error("The free-entry method is not configured");

  const normalizedEmail = input.email.toLowerCase();
  const dateKey = localDateKey(now, campaign.timezone);
  const fingerprintHash = sha256(`${tenant.id}:${campaign.id}:${normalizedEmail}:${dateKey}`);
  const duplicate = await db.freeEntrySubmission.findUnique({
    where: { campaignId_fingerprintHash: { campaignId: campaign.id, fingerprintHash } },
  });
  if (duplicate) throw new Error("One free-entry submission per email is allowed each campaign calendar day. You can return tomorrow while entry is open.");

  try {
    return await db.$transaction(async (tx) => {
    let entrant = authenticatedIdentity
      ? await tx.entrant.findFirst({
          where: {
            id: authenticatedIdentity.entrantId,
            tenantId: tenant.id,
            userId: authenticatedIdentity.userId,
            normalizedEmail,
          },
        })
      : await tx.entrant.findFirst({
          where: { tenantId: tenant.id, normalizedEmail },
          orderBy: { createdAt: "asc" },
        });
    if (authenticatedIdentity && !entrant) throw new Error("Verified account identity does not match free entry");
    if (!entrant) {
      entrant = await tx.entrant.create({
        data: {
          tenantId: tenant.id,
          normalizedEmail,
          emailHash: sha256(normalizedEmail),
          name: input.name,
          phone: input.phone,
          region: eligibleLocation.normalizedRegion,
          postalCode: input.postalCode,
          country: eligibleLocation.normalizedCountry,
          eligibilityAttested: true,
        },
      });
    } else if (authenticatedIdentity || !entrant.userId) {
      entrant = await tx.entrant.update({
        where: { id: entrant.id },
        data: {
          name: input.name,
          phone: input.phone,
          region: eligibleLocation.normalizedRegion,
          postalCode: input.postalCode,
          country: eligibleLocation.normalizedCountry,
          eligibilityAttested: true,
        },
      });
    }
    const existingCampaignEntrant = await tx.campaignEntrant.findUnique({
      where: { campaignId_entrantId: { campaignId: campaign.id, entrantId: entrant.id } },
    });
    if (existingCampaignEntrant && existingCampaignEntrant.status !== "ELIGIBLE") {
      throw new Error("This entrant is not eligible for the promotion");
    }
    if (!existingCampaignEntrant) {
      await tx.campaignEntrant.create({
        data: {
          campaignId: campaign.id,
          entrantId: entrant.id,
          status: "ELIGIBLE",
          eligibilityJson: JSON.stringify({
            ageConfirmed: true,
            minimumAge: campaign.minimumAge,
            residenceConfirmed: true,
            country: eligibleLocation.normalizedCountry,
            region: eligibleLocation.normalizedRegion,
          }),
        },
      });
    }
    const account = await tx.entryAccount.upsert({
      where: { campaignId_entrantId: { campaignId: campaign.id, entrantId: entrant.id } },
      update: {},
      create: { tenantId: tenant.id, campaignId: campaign.id, entrantId: entrant.id },
    });
    const remaining = campaign.maxEntriesPerEntrant == null
      ? fixedRule.baseEntries
      : campaign.maxEntriesPerEntrant > account.balance
        ? campaign.maxEntriesPerEntrant - account.balance
        : 0n;
    const entries = fixedRule.baseEntries < remaining ? fixedRule.baseEntries : remaining;
    if (entries <= 0n) throw new Error("You have reached the entry cap for this promotion");
    const code = confirmationCode();
    const submission = await tx.freeEntrySubmission.create({
      data: {
        tenantId: tenant.id,
        campaignId: campaign.id,
        entrantId: entrant.id,
        method: "ONLINE",
        status: process.env.DEMO_MODE === "true" ? "APPROVED" : "PENDING",
        entriesRequested: entries,
        confirmationCode: code,
        rulesVersion: campaign.rulesVersion,
        eligibilityJson: JSON.stringify({
          ageConfirmed: true,
          minimumAge: campaign.minimumAge,
          residenceConfirmed: true,
          country: eligibleLocation.normalizedCountry,
          region: eligibleLocation.normalizedRegion,
          contactPhone: input.phone,
        }),
        fingerprintHash,
        reviewedAt: process.env.DEMO_MODE === "true" ? now : null,
        reviewedBy: process.env.DEMO_MODE === "true" ? "automatic-demo-review" : null,
      },
    });

    if (process.env.DEMO_MODE === "true") {
      const calculationJson = JSON.stringify({
        schemaVersion: 1,
        method: "ONLINE_AMOE",
        ruleId: fixedRule.id,
        rulesVersion: campaign.rulesVersion,
        officialRulesDocumentId: officialRules.id,
        officialRulesChecksum: officialRules.checksum,
        fixedEntries: fixedRule.baseEntries.toString(),
        awardedAfterEntrantCap: entries.toString(),
        localEntryDate: dateKey,
      });
      const entitlement = await tx.entryEntitlement.create({
        data: {
          tenantId: tenant.id,
          entryAccountId: account.id,
          freeEntrySubmissionId: submission.id,
          originType: "FREE_ENTRY",
          originalEntries: entries,
          calculationJson,
          campaignConfigHash: campaign.configChecksum,
          idempotencyKey: `free-entry:${submission.id}`,
          effectiveAt: now,
        },
      });
      await tx.entryLedgerEvent.create({
        data: {
          tenantId: tenant.id,
          entryAccountId: account.id,
          entitlementId: entitlement.id,
          kind: "GRANT",
          delta: entries,
          idempotencyKey: `free-entry-ledger:${submission.id}`,
          effectiveAt: now,
          actorType: "SYSTEM",
          reasonCode: "AMOE_APPROVED",
          metadataJson: JSON.stringify({ confirmationCode: code, localEntryDate: dateKey }),
        },
      });
      await tx.entryAccount.update({
        where: { id: account.id },
        data: { balance: { increment: entries }, version: { increment: 1 } },
      });
    }

    const persistedOfficialRules = await tx.legalDocument.findFirst({
      where: {
        id: officialRules.id,
        tenantId: tenant.id,
        kind: "OFFICIAL_RULES",
        status: "PUBLISHED",
        version: campaign.rulesVersion,
        checksum: officialRules.checksum,
      },
    });
    if (!persistedOfficialRules) throw new Error("The campaign's exact published Official Rules are unavailable");
    await tx.rulesAcceptance.upsert({
      where: {
        campaignId_entrantId_legalDocumentId_method: {
          campaignId: campaign.id,
          entrantId: entrant.id,
          legalDocumentId: persistedOfficialRules.id,
          method: "FREE_ENTRY",
        },
      },
      update: {},
      create: {
        tenantId: tenant.id,
        campaignId: campaign.id,
        entrantId: entrant.id,
        legalDocumentId: persistedOfficialRules.id,
        documentChecksum: persistedOfficialRules.checksum,
        method: "FREE_ENTRY",
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: tenant.id,
        actorType: "ENTRANT",
        actorId: entrant.id,
        action: "FREE_ENTRY_SUBMITTED",
        resourceType: "FreeEntrySubmission",
        resourceId: submission.id,
        metadataJson: JSON.stringify({ confirmationCode: code, status: submission.status, entries: entries.toString() }),
      },
    });
    await tx.outboxEvent.create({
      data: {
        tenantId: tenant.id,
        aggregateType: "FreeEntrySubmission",
        aggregateId: submission.id,
        kind: "FREE_ENTRY_RECEIPT",
        payloadJson: JSON.stringify({ submissionId: submission.id }),
        idempotencyKey: `free-entry-receipt:${submission.id}`,
      },
    });
      return { confirmationCode: code, entries, status: submission.status };
    });
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "P2002"
      && await db.freeEntrySubmission.findUnique({
        where: { campaignId_fingerprintHash: { campaignId: campaign.id, fingerprintHash } },
        select: { id: true },
      })
    ) {
      throw new Error("One free-entry submission per email is allowed each campaign calendar day. You can return tomorrow while entry is open.");
    }
    throw error;
  }
}
