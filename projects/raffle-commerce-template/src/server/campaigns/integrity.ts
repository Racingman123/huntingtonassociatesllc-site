import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/server/db";
import { PURCHASE_ENTRY_TARGET_TYPES, type PurchaseEntryTargetType } from "@/lib/purchase-entry-rules";
import { analyzePurchaseEntryCatalog } from "./catalog-readiness";
import { requiredOperationalApprovalKinds, stableJson } from "./overlay";

type DatabaseClient = Prisma.TransactionClient | typeof db;

const catalogProtectedCampaignStatuses = [
  "SCHEDULED",
  "LIVE",
] as const;

const publicationApprovalKinds = [
  "SPONSOR_ADMIN_PUBLICATION",
  "COMPLIANCE_WITNESS_PUBLICATION",
] as const;

type StoredCampaignReleaseManifest = Record<string, unknown> & {
  schemaVersion: 3;
  purchaseCatalog: Array<{
    id: string;
    slug: string;
    productType: string;
    category: string;
    variants: Array<{ id: string; sku: string }>;
    collections: Array<{ id: string; slug: string }>;
  }>;
  membershipPlans: unknown[];
};

export const requiredCampaignApprovalKinds = [
  ...publicationApprovalKinds,
  ...requiredOperationalApprovalKinds,
] as const;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function instant(value: Date | null) {
  return value?.toISOString() ?? null;
}

/**
 * Builds the database-native release manifest. Lifecycle state and generated
 * timestamps are deliberately excluded; every entrant-affecting campaign
 * field and every reviewed child/evidence row is included and deterministically
 * ordered. IDs are included so replacing a reviewed row changes the digest.
 */
export async function readCampaignReleaseManifest(client: DatabaseClient, campaignId: string) {
  const campaign = await client.campaign.findUnique({
    where: { id: campaignId },
    include: {
      tenant: {
        select: {
          id: true,
          currency: true,
          products: {
            where: {
              status: "ACTIVE",
              productType: { not: "MEMBERSHIP" },
            },
            orderBy: [{ slug: "asc" }, { id: "asc" }],
            select: {
              id: true,
              slug: true,
              status: true,
              productType: true,
              category: true,
              priceCents: true,
              entryMultiplier: true,
              variants: {
                where: { status: "ACTIVE" },
                orderBy: [{ sku: "asc" }, { id: "asc" }],
                select: {
                  id: true,
                  sku: true,
                  status: true,
                  priceCents: true,
                },
              },
              collections: {
                orderBy: [{ collectionId: "asc" }, { productId: "asc" }],
                select: {
                  collection: { select: { id: true, slug: true } },
                },
              },
            },
          },
        },
      },
      officialRulesDocument: {
        select: {
          id: true,
          tenantId: true,
          kind: true,
          version: true,
          checksum: true,
          body: true,
          status: true,
          effectiveAt: true,
        },
      },
      prizes: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
      entryRules: { orderBy: [{ stackPriority: "asc" }, { id: "asc" }] },
      multiplierSlots: { orderBy: [{ startsAt: "asc" }, { id: "asc" }] },
      membershipBands: {
        orderBy: [{ planId: "asc" }, { minimumSettledCycles: "asc" }, { id: "asc" }],
        include: {
          plan: {
            include: {
              product: {
                include: {
                  variants: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
                },
              },
            },
          },
        },
      },
      approvals: { orderBy: [{ kind: "asc" }, { id: "asc" }] },
      filingRequirements: { orderBy: [{ jurisdiction: "asc" }, { kind: "asc" }, { id: "asc" }] },
    },
  });
  if (!campaign) throw new Error("Campaign not found");

  const manifest = {
    schemaVersion: 3,
    tenant: { id: campaign.tenant.id, currency: campaign.tenant.currency },
    campaign: {
      id: campaign.id,
      tenantId: campaign.tenantId,
      slug: campaign.slug,
      code: campaign.code,
      title: campaign.title,
      eyebrow: campaign.eyebrow,
      shortDescription: campaign.shortDescription,
      longDescription: campaign.longDescription,
      kind: campaign.kind,
      timezone: campaign.timezone,
      startsAt: instant(campaign.startsAt),
      endsAt: instant(campaign.endsAt),
      freeEntryEndsAt: instant(campaign.freeEntryEndsAt),
      drawAt: instant(campaign.drawAt),
      baseEntriesPerDollar: campaign.baseEntriesPerDollar,
      currentMultiplier: campaign.currentMultiplier,
      maxEntriesPerEntrant: campaign.maxEntriesPerEntrant?.toString() ?? null,
      noPurchaseDisclosure: campaign.noPurchaseDisclosure,
      eligibilitySummary: campaign.eligibilitySummary,
      minimumAge: campaign.minimumAge,
      eligibleCountriesJson: campaign.eligibleCountriesJson,
      eligibleRegionsJson: campaign.eligibleRegionsJson,
      excludedRegionsJson: campaign.excludedRegionsJson,
      rulesVersion: campaign.rulesVersion,
      officialRulesDocumentId: campaign.officialRulesDocumentId,
      officialRulesChecksum: campaign.officialRulesChecksum,
    },
    officialRules: campaign.officialRulesDocument && {
      id: campaign.officialRulesDocument.id,
      tenantId: campaign.officialRulesDocument.tenantId,
      kind: campaign.officialRulesDocument.kind,
      version: campaign.officialRulesDocument.version,
      checksum: campaign.officialRulesDocument.checksum,
      bodyChecksum: sha256(campaign.officialRulesDocument.body),
      status: campaign.officialRulesDocument.status,
      effectiveAt: instant(campaign.officialRulesDocument.effectiveAt),
    },
    prizes: campaign.prizes.map((prize) => ({
      id: prize.id,
      tenantId: prize.tenantId,
      name: prize.name,
      description: prize.description,
      approximateValueCents: prize.approximateValueCents,
      currency: prize.currency,
      quantity: prize.quantity,
      cashAlternativeCents: prize.cashAlternativeCents,
      image: prize.image,
      sortOrder: prize.sortOrder,
    })),
    entryRules: campaign.entryRules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      ruleType: rule.ruleType,
      targetType: rule.targetType,
      targetId: rule.targetId,
      baseEntries: rule.baseEntries.toString(),
      entriesPerDollar: rule.entriesPerDollar,
      multiplierNumerator: rule.multiplierNumerator,
      multiplierDenominator: rule.multiplierDenominator,
      stackPriority: rule.stackPriority,
      startsAt: instant(rule.startsAt),
      endsAt: instant(rule.endsAt),
      version: rule.version,
      active: rule.active,
    })),
    multiplierSlots: campaign.multiplierSlots.map((slot) => ({
      id: slot.id,
      label: slot.label,
      numerator: slot.numerator,
      denominator: slot.denominator,
      startsAt: instant(slot.startsAt),
      endsAt: instant(slot.endsAt),
    })),
    membershipBands: campaign.membershipBands.map((band) => ({
      id: band.id,
      planId: band.planId,
      minimumSettledCycles: band.minimumSettledCycles,
      maximumSettledCycles: band.maximumSettledCycles,
      fixedEntries: band.fixedEntries.toString(),
      multiplierNumerator: band.multiplierNumerator,
      multiplierDenominator: band.multiplierDenominator,
    })),
    membershipPlans: [...new Map(campaign.membershipBands.map(({ plan }) => [plan.id, {
      id: plan.id,
      tenantId: plan.tenantId,
      productId: plan.productId,
      name: plan.name,
      status: plan.status,
      interval: plan.interval,
      intervalCount: plan.intervalCount,
      priceCents: plan.priceCents,
      currency: plan.currency,
      baseEntries: plan.baseEntries.toString(),
      providerPriceId: plan.providerPriceId,
      product: {
        id: plan.product.id,
        tenantId: plan.product.tenantId,
        slug: plan.product.slug,
        title: plan.product.title,
        status: plan.product.status,
        productType: plan.product.productType,
        category: plan.product.category,
        priceCents: plan.product.priceCents,
        entryMultiplier: plan.product.entryMultiplier,
        variants: plan.product.variants.map((variant) => ({
          id: variant.id,
          tenantId: variant.tenantId,
          productId: variant.productId,
          sku: variant.sku,
          title: variant.title,
          priceCents: variant.priceCents,
          status: variant.status,
          createdAt: instant(variant.createdAt),
        })),
      },
    }])).values()].sort((left, right) => left.id.localeCompare(right.id)),
    approvals: campaign.approvals.map((approval) => ({
      id: approval.id,
      tenantId: approval.tenantId,
      kind: approval.kind,
      status: approval.status,
      // configChecksum is verified separately and excluded to avoid a digest
      // that recursively contains itself.
      rulesChecksum: approval.rulesChecksum,
      approverId: approval.approverId,
      notes: approval.notes,
      evidenceRef: approval.evidenceRef,
      decidedAt: instant(approval.decidedAt),
    })),
    filingRequirements: campaign.filingRequirements.map((requirement) => ({
      id: requirement.id,
      tenantId: requirement.tenantId,
      jurisdiction: requirement.jurisdiction,
      kind: requirement.kind,
      triggerReason: requirement.triggerReason,
      dueAt: instant(requirement.dueAt),
      status: requirement.status,
      evidenceRef: requirement.evidenceRef,
      waiverRationale: requirement.waiverRationale,
      approvedBy: requirement.approvedBy,
      completedAt: instant(requirement.completedAt),
    })),
    purchaseCatalog: campaign.tenant.products.map((product) => ({
      id: product.id,
      slug: product.slug,
      status: product.status,
      productType: product.productType,
      category: product.category,
      priceCents: product.priceCents,
      entryMultiplier: product.entryMultiplier,
      variants: product.variants.map((variant) => ({
        id: variant.id,
        sku: variant.sku,
        status: variant.status,
        priceCents: variant.priceCents,
      })),
      collections: product.collections.map(({ collection }) => ({
        id: collection.id,
        slug: collection.slug,
      })),
    })),
  };

  return { campaign, manifest, checksum: sha256(stableJson(manifest)) };
}

export function campaignReleaseManifestJson(manifest: unknown) {
  return stableJson(manifest);
}

function readStoredManifest(value: string | null): StoredCampaignReleaseManifest | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredCampaignReleaseManifest>;
    if (
      !parsed
      || typeof parsed !== "object"
      || parsed.schemaVersion !== 3
      || !Array.isArray(parsed.purchaseCatalog)
      || !Array.isArray(parsed.membershipPlans)
      || !parsed.purchaseCatalog.every((product) => (
        product
        && typeof product.id === "string"
        && typeof product.slug === "string"
        && typeof product.productType === "string"
        && typeof product.category === "string"
        && Array.isArray(product.variants)
        && product.variants.every((variant) => (
          variant && typeof variant.id === "string" && typeof variant.sku === "string"
        ))
        && Array.isArray(product.collections)
        && product.collections.every((collection) => (
          collection && typeof collection.id === "string" && typeof collection.slug === "string"
        ))
      ))
      || campaignReleaseManifestJson(parsed) !== value
    ) return null;
    return parsed as StoredCampaignReleaseManifest;
  } catch {
    return null;
  }
}

export async function inspectCampaignReleaseIntegrity(client: DatabaseClient, campaignId: string) {
  const release = await readCampaignReleaseManifest(client, campaignId);
  const reasons: string[] = [];
  const { campaign } = release;
  if (!campaign.approvedAt) reasons.push("campaign release is not approved");
  if (!/^[a-f0-9]{64}$/.test(campaign.configChecksum)) reasons.push("stored release checksum is malformed");
  const storedManifest = readStoredManifest(campaign.releaseManifestJson);
  const compareBoundCatalog = catalogProtectedCampaignStatuses.includes(
    campaign.status as (typeof catalogProtectedCampaignStatuses)[number],
  );
  if (!storedManifest) {
    reasons.push("immutable campaign release manifest is missing or malformed");
  } else {
    const storedChecksum = sha256(campaignReleaseManifestJson(storedManifest));
    if (campaign.configChecksum !== storedChecksum) {
      reasons.push("immutable campaign release manifest checksum does not match");
    }
    const compareCurrent = compareBoundCatalog
      ? release.manifest
      : {
          ...release.manifest,
          purchaseCatalog: storedManifest.purchaseCatalog,
          membershipPlans: storedManifest.membershipPlans,
        };
    if (campaignReleaseManifestJson(compareCurrent) !== campaignReleaseManifestJson(storedManifest)) {
      reasons.push(compareBoundCatalog
        ? "current campaign release or bound catalog differs from immutable release evidence"
        : "current campaign release differs from immutable release evidence");
    }
  }

  const rules = campaign.officialRulesDocument;
  if (
    !rules
    || rules.id !== campaign.officialRulesDocumentId
    || rules.tenantId !== campaign.tenantId
    || rules.kind !== "OFFICIAL_RULES"
    || rules.status !== "PUBLISHED"
    || rules.version !== campaign.rulesVersion
    || rules.checksum !== campaign.officialRulesChecksum
    || sha256(rules.body) !== rules.checksum
  ) {
    reasons.push("exact published Official Rules binding is invalid");
  }

  for (const kind of requiredCampaignApprovalKinds) {
    const matches = campaign.approvals.filter((approval) => approval.kind === kind);
    if (matches.length !== 1) {
      reasons.push(`campaign approval ${kind} must appear exactly once`);
      continue;
    }
    const approval = matches[0]!;
    if (
      approval.status !== "APPROVED"
      || approval.configChecksum !== campaign.configChecksum
      || approval.rulesChecksum !== campaign.officialRulesChecksum
      || !approval.approverId
      || !approval.evidenceRef
      || !approval.notes
      || !approval.decidedAt
    ) {
      reasons.push(`campaign approval ${kind} is incomplete or bound to a different release`);
    }
  }
  const sponsor = campaign.approvals.find((item) => item.kind === publicationApprovalKinds[0]);
  const witness = campaign.approvals.find((item) => item.kind === publicationApprovalKinds[1]);
  if (sponsor?.approverId && witness?.approverId && sponsor.approverId === witness.approverId) {
    reasons.push("campaign publication requires distinct sponsor and compliance approvers");
  }
  if (campaign.filingRequirements.length < 1) reasons.push("campaign filing determination is missing");
  if (campaign.prizes.length !== 1 || campaign.prizes[0]?.quantity !== 1) {
    reasons.push("campaign release must contain exactly one single-quantity prize");
  }
  for (const band of campaign.membershipBands) {
    if (
      band.plan.tenantId !== campaign.tenantId
      || band.plan.product.tenantId !== campaign.tenantId
      || band.plan.productId !== band.plan.product.id
      || band.plan.product.productType !== "MEMBERSHIP"
    ) {
      reasons.push(`membership plan '${band.planId}' is not bound to the campaign tenant and membership product`);
    }
  }

  const purchaseRules = campaign.entryRules.filter((rule) => rule.ruleType === "MONEY_RATE");
  const unsupportedTargets = purchaseRules.filter((rule) => (
    !PURCHASE_ENTRY_TARGET_TYPES.includes(rule.targetType as PurchaseEntryTargetType)
  ));
  for (const rule of unsupportedTargets) {
    reasons.push(`purchase-entry rule '${rule.name}' has unsupported target type '${rule.targetType}'`);
  }
  const catalogProducts = !compareBoundCatalog && storedManifest
    ? storedManifest.purchaseCatalog.map((product) => ({
        ...product,
        collections: product.collections.map((collection) => ({ collection })),
      }))
    : campaign.tenant.products;
  const catalogReadiness = analyzePurchaseEntryCatalog({
    purchaseStartsAt: campaign.startsAt.toISOString(),
    purchaseEndsAt: campaign.endsAt.toISOString(),
    rules: purchaseRules.filter((rule) => (
      PURCHASE_ENTRY_TARGET_TYPES.includes(rule.targetType as PurchaseEntryTargetType)
    )).map((rule) => ({
      name: rule.name,
      targetType: rule.targetType as PurchaseEntryTargetType,
      targetId: rule.targetId,
      startsAt: instant(rule.startsAt),
      endsAt: instant(rule.endsAt),
      active: rule.active,
    })),
    products: catalogProducts,
  });
  for (const issue of catalogReadiness.issues) {
    reasons.push(`purchase-entry catalog: ${issue}`);
  }

  return { ...release, catalogReadiness, valid: reasons.length === 0, reasons };
}

export async function assertCampaignReleaseIntegrity(client: DatabaseClient, campaignId: string) {
  const integrity = await inspectCampaignReleaseIntegrity(client, campaignId);
  if (!integrity.valid) {
    throw new Error(`Campaign release integrity failed: ${integrity.reasons.join("; ")}`);
  }
  return integrity;
}
