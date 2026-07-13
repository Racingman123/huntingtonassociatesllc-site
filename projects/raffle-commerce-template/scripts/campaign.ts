import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  campaignEntryWindow,
  campaignOverlayChecksum,
  entryWindowsOverlap,
  parseCampaignOverlay,
  publicationStatus,
  type CampaignOverlay,
} from "../src/server/campaigns/overlay";
import {
  campaignReleaseManifestJson,
  readCampaignReleaseManifest,
} from "../src/server/campaigns/integrity";
import {
  analyzePurchaseEntryCatalog,
  assertPurchaseEntryCatalogReady,
} from "../src/server/campaigns/catalog-readiness";

const prisma = new PrismaClient();

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  npm run campaign:validate -- config/campaign.example.json",
    "  npm run campaign:plan -- config/campaign.example.json",
    "  npm run campaign:publish -- config/campaign.example.json --actor <active-admin-user-id> --witness <active-compliance-user-id> --confirm",
  ].join("\n"));
}

async function loadOverlay(file: string) {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(file), "utf8"));
  } catch (error) {
    throw new Error(`Unable to read campaign JSON: ${error instanceof Error ? error.message : "invalid input"}`);
  }
  const overlay = parseCampaignOverlay(value);
  return { overlay, checksum: campaignOverlayChecksum(overlay) };
}

function existingWindow(campaign: { startsAt: Date; endsAt: Date; freeEntryEndsAt: Date }) {
  return {
    startsAt: campaign.startsAt,
    endsAt: new Date(Math.max(campaign.endsAt.getTime(), campaign.freeEntryEndsAt.getTime())),
  };
}

function isRulesReady(
  rules: { body: string; checksum: string; effectiveAt: Date | null } | null,
  overlay: CampaignOverlay,
) {
  const bodyChecksum = rules
    ? createHash("sha256").update(rules.body).digest("hex")
    : null;
  return Boolean(
    rules
    && rules.checksum === overlay.campaign.officialRules.checksum
    && bodyChecksum === rules.checksum
    && rules.effectiveAt
    && rules.effectiveAt <= new Date(overlay.campaign.windows.startsAt),
  );
}

function purchaseEntryCatalogReadiness(
  overlay: CampaignOverlay,
  products: Parameters<typeof analyzePurchaseEntryCatalog>[0]["products"],
) {
  return analyzePurchaseEntryCatalog({
    purchaseStartsAt: overlay.campaign.windows.startsAt,
    purchaseEndsAt: overlay.campaign.windows.purchaseEndsAt,
    rules: overlay.campaign.purchaseEntryRules,
    products,
  });
}

async function inspectState(overlay: CampaignOverlay) {
  const membershipPlanSlugs = [...new Set(
    overlay.campaign.membershipEntryBands.map((band) => band.planProductSlug),
  )];
  const tenant = await prisma.tenant.findFirst({
    where: { slug: overlay.targetTenantSlug, status: "ACTIVE" },
    select: {
      id: true,
      slug: true,
      currency: true,
      campaigns: {
        where: { status: { in: ["LIVE", "SCHEDULED"] } },
        select: { id: true, slug: true, code: true, status: true, startsAt: true, endsAt: true, freeEntryEndsAt: true },
      },
      legalDocuments: {
        where: {
          kind: "OFFICIAL_RULES",
          version: overlay.campaign.officialRules.version,
          status: "PUBLISHED",
        },
        select: { id: true, body: true, checksum: true, effectiveAt: true },
        take: 1,
      },
      products: {
        where: {
          status: "ACTIVE",
          productType: { not: "MEMBERSHIP" },
        },
        select: {
          id: true,
          slug: true,
          category: true,
          productType: true,
          variants: {
            where: { status: "ACTIVE" },
            select: { id: true, sku: true },
          },
          collections: {
            select: { collection: { select: { id: true, slug: true } } },
          },
        },
      },
      subscriptionPlans: {
        where: {
          status: "ACTIVE",
          product: {
            slug: { in: membershipPlanSlugs },
            status: "ACTIVE",
            productType: "MEMBERSHIP",
          },
        },
        select: {
          id: true,
          currency: true,
          product: { select: { slug: true } },
        },
      },
    },
  });
  if (!tenant) throw new Error(`Active tenant '${overlay.targetTenantSlug}' not found`);
  const collision = await prisma.campaign.findFirst({
    where: {
      tenantId: tenant.id,
      OR: [{ slug: overlay.campaign.slug }, { code: overlay.campaign.code }],
    },
    select: { slug: true, code: true, status: true },
  });
  const desiredWindow = campaignEntryWindow(overlay);
  const overlaps = tenant.campaigns.filter((campaign) => entryWindowsOverlap(
    desiredWindow,
    existingWindow(campaign),
  ));
  const rules = tenant.legalDocuments[0] ?? null;
  const catalogReadiness = purchaseEntryCatalogReadiness(overlay, tenant.products);
  return { tenant, collision, overlaps, rules, membershipPlanSlugs, catalogReadiness };
}

async function printPlan(overlay: CampaignOverlay, checksum: string) {
  const state = await inspectState(overlay);
  let targetStatus: "LIVE" | "SCHEDULED" | "BLOCKED" = "BLOCKED";
  let timingIssue: string | null = null;
  try {
    targetStatus = publicationStatus(overlay);
  } catch (error) {
    timingIssue = error instanceof Error ? error.message : "Campaign timing is not publishable";
  }
  const rulesReady = isRulesReady(state.rules, overlay);
  const currencyReady = state.tenant.currency === overlay.campaign.currency;
  const membershipPlans = state.membershipPlanSlugs.map((planProductSlug) => {
    const matches = state.tenant.subscriptionPlans.filter((plan) => plan.product.slug === planProductSlug);
    return {
      planProductSlug,
      ready: matches.length === 1 && matches[0]?.currency === overlay.campaign.currency,
      matches: matches.map((plan) => ({ id: plan.id, currency: plan.currency })),
    };
  });
  const checks = {
    tenantCurrency: {
      ready: currencyReady,
      configured: overlay.campaign.currency,
      tenant: state.tenant.currency,
    },
    identityCollision: {
      ready: !state.collision,
      collision: state.collision,
    },
    liveOrScheduledWindowOverlap: {
      ready: state.overlaps.length === 0,
      campaigns: state.overlaps.map((campaign) => ({
        slug: campaign.slug,
        code: campaign.code,
        status: campaign.status,
        startsAt: campaign.startsAt.toISOString(),
        entryEndsAt: existingWindow(campaign).endsAt.toISOString(),
      })),
    },
    legalReadiness: {
      ready: rulesReady,
      requestedVersion: overlay.campaign.officialRules.version,
      requestedChecksum: overlay.campaign.officialRules.checksum,
      publishedVersionFound: Boolean(state.rules),
      publishedChecksumMatches: state.rules?.checksum === overlay.campaign.officialRules.checksum,
      publishedBodyChecksum: state.rules
        ? createHash("sha256").update(state.rules.body).digest("hex")
        : null,
      publishedBodyMatchesStoredChecksum: Boolean(
        state.rules
        && createHash("sha256").update(state.rules.body).digest("hex") === state.rules.checksum,
      ),
      effectiveByCampaignStart: Boolean(
        state.rules?.effectiveAt
        && state.rules.effectiveAt <= new Date(overlay.campaign.windows.startsAt),
      ),
    },
    membershipPlans: {
      ready: membershipPlans.every((plan) => plan.ready),
      plans: membershipPlans,
    },
    purchaseEntryCatalog: state.catalogReadiness,
    operationalEvidence: {
      ready: true,
      approvals: overlay.campaign.operationalApprovals.map((approval) => ({
        kind: approval.kind,
        evidenceRef: approval.evidenceRef,
      })),
    },
    filingEvidence: {
      ready: true,
      mode: overlay.campaign.filingDetermination.mode,
      count: overlay.campaign.filingDetermination.mode === "REQUIREMENTS"
        ? overlay.campaign.filingDetermination.requirements.length
        : 1,
    },
    timing: { ready: timingIssue === null, issue: timingIssue },
  };
  console.log(JSON.stringify({
    tenant: state.tenant.slug,
    campaign: { slug: overlay.campaign.slug, code: overlay.campaign.code },
    configChecksum: checksum,
    targetStatus,
    checks,
    publishReady: Object.values(checks).every((check) => check.ready),
  }, null, 2));
}

function currentMultiplier(overlay: CampaignOverlay, now: Date) {
  const slots = overlay.campaign.multiplierSchedule;
  const active = slots.find((slot) => (
    new Date(slot.startsAt) <= now && now < new Date(slot.endsAt)
  ));
  const slot = active ?? slots[0]!;
  return slot.numerator / slot.denominator;
}

async function publish(overlay: CampaignOverlay, checksum: string) {
  if (!process.argv.includes("--confirm")) {
    throw new Error("Publishing creates an entrant-visible promotion. Review campaign:plan and pass --confirm.");
  }
  const actorId = option("--actor");
  const witnessId = option("--witness");
  if (!actorId || !witnessId) usage();
  if (actorId === witnessId) throw new Error("--actor and --witness must identify distinct people");

  const now = new Date();
  const status = publicationStatus(overlay, now);
  const desiredWindow = campaignEntryWindow(overlay);

  const result = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.findFirst({
      where: { slug: overlay.targetTenantSlug, status: "ACTIVE" },
      select: { id: true, slug: true, currency: true },
    });
    if (!tenant) throw new Error(`Active tenant '${overlay.targetTenantSlug}' not found`);
    if (tenant.currency !== overlay.campaign.currency) {
      throw new Error(`Campaign currency ${overlay.campaign.currency} does not match tenant currency ${tenant.currency}`);
    }

    const [actor, witness] = await Promise.all([
      tx.user.findFirst({
        where: { id: actorId, tenantId: tenant.id, status: "ACTIVE", role: "ADMIN" },
        select: { id: true },
      }),
      tx.user.findFirst({
        where: { id: witnessId, tenantId: tenant.id, status: "ACTIVE", role: "COMPLIANCE" },
        select: { id: true },
      }),
    ]);
    if (!actor) throw new Error("--actor must identify an active ADMIN in the target tenant");
    if (!witness) throw new Error("--witness must identify an active COMPLIANCE user in the target tenant");

    const rules = await tx.legalDocument.findFirst({
      where: {
        tenantId: tenant.id,
        kind: "OFFICIAL_RULES",
        version: overlay.campaign.officialRules.version,
        checksum: overlay.campaign.officialRules.checksum,
        status: "PUBLISHED",
      },
      select: { id: true, body: true, checksum: true, effectiveAt: true },
    });
    if (!rules || !isRulesReady(rules, overlay)) {
      throw new Error("The exact Official Rules version/checksum must be published and effective by campaign start");
    }

    const catalogProducts = await tx.product.findMany({
      where: {
        tenantId: tenant.id,
        status: "ACTIVE",
        productType: { not: "MEMBERSHIP" },
      },
      select: {
        id: true,
        slug: true,
        category: true,
        productType: true,
        variants: {
          where: { status: "ACTIVE" },
          select: { id: true, sku: true },
        },
        collections: {
          select: { collection: { select: { id: true, slug: true } } },
        },
      },
    });
    const catalogReadiness = purchaseEntryCatalogReadiness(overlay, catalogProducts);
    assertPurchaseEntryCatalogReady(catalogReadiness);

    const requestedPlanSlugs = [...new Set(
      overlay.campaign.membershipEntryBands.map((band) => band.planProductSlug),
    )];
    const membershipPlans = await tx.subscriptionPlan.findMany({
      where: {
        tenantId: tenant.id,
        status: "ACTIVE",
        product: {
          slug: { in: requestedPlanSlugs },
          status: "ACTIVE",
          productType: "MEMBERSHIP",
        },
      },
      select: { id: true, currency: true, product: { select: { slug: true } } },
    });
    const planByProductSlug = new Map(membershipPlans.map((plan) => [plan.product.slug, plan]));
    for (const planProductSlug of requestedPlanSlugs) {
      const plan = planByProductSlug.get(planProductSlug);
      if (!plan) throw new Error(`Active membership plan product '${planProductSlug}' was not found in the target tenant`);
      if (plan.currency !== overlay.campaign.currency) {
        throw new Error(`Membership plan '${planProductSlug}' currency ${plan.currency} does not match campaign currency ${overlay.campaign.currency}`);
      }
    }

    const collision = await tx.campaign.findFirst({
      where: {
        tenantId: tenant.id,
        OR: [{ slug: overlay.campaign.slug }, { code: overlay.campaign.code }],
      },
      select: { slug: true, code: true },
    });
    if (collision) {
      throw new Error(`Campaign identity collides with existing slug '${collision.slug}' or code '${collision.code}'`);
    }

    const activeCampaigns = await tx.campaign.findMany({
      where: { tenantId: tenant.id, status: { in: ["LIVE", "SCHEDULED"] } },
      select: { slug: true, code: true, startsAt: true, endsAt: true, freeEntryEndsAt: true },
    });
    const overlap = activeCampaigns.find((campaign) => entryWindowsOverlap(
      desiredWindow,
      existingWindow(campaign),
    ));
    if (overlap) {
      throw new Error(`Entry window overlaps LIVE/SCHEDULED campaign '${overlap.slug}' (${overlap.code}); cancel or reschedule explicitly`);
    }

    const campaign = overlay.campaign;
    // Build the full release while it is still an invisible draft. The final
    // database-native checksum and approval instant are written only after all
    // reviewed children and evidence rows exist.
    const created = await tx.campaign.create({
      data: {
        tenantId: tenant.id,
        slug: campaign.slug,
        code: campaign.code,
        title: campaign.title,
        eyebrow: campaign.eyebrow,
        shortDescription: campaign.shortDescription,
        longDescription: campaign.longDescription,
        status: "DRAFT",
        kind: campaign.kind,
        timezone: campaign.timezone,
        startsAt: new Date(campaign.windows.startsAt),
        endsAt: new Date(campaign.windows.purchaseEndsAt),
        freeEntryEndsAt: new Date(campaign.windows.freeEntryEndsAt),
        drawAt: new Date(campaign.windows.drawAt),
        baseEntriesPerDollar: campaign.baseEntriesPerCurrencyUnit,
        currentMultiplier: currentMultiplier(overlay, now),
        maxEntriesPerEntrant: BigInt(campaign.maxEntriesPerEntrant),
        noPurchaseDisclosure: campaign.noPurchaseDisclosure,
        eligibilitySummary: campaign.eligibilitySummary,
        minimumAge: campaign.eligibility.minimumAge,
        eligibleCountriesJson: JSON.stringify(campaign.eligibility.eligibleCountries),
        eligibleRegionsJson: JSON.stringify(campaign.eligibility.eligibleRegions),
        excludedRegionsJson: JSON.stringify(campaign.eligibility.excludedRegions),
        rulesVersion: campaign.officialRules.version,
        officialRulesDocumentId: rules.id,
        officialRulesChecksum: rules.checksum,
        configChecksum: "0".repeat(64),
        releaseManifestJson: null,
        approvedAt: null,
        prizes: {
          create: campaign.prizes.map((prize) => ({
            tenantId: tenant.id,
            name: prize.name,
            description: prize.description,
            approximateValueCents: prize.approximateValueCents,
            currency: prize.currency,
            quantity: prize.quantity,
            cashAlternativeCents: prize.cashAlternativeCents,
            image: prize.image || null,
            sortOrder: prize.sortOrder,
          })),
        },
        entryRules: {
          create: [
            ...campaign.purchaseEntryRules.map((rule) => ({
              name: rule.name,
              ruleType: "MONEY_RATE",
              targetType: rule.targetType,
              targetId: rule.targetId,
              baseEntries: 0n,
              entriesPerDollar: rule.entriesPerCurrencyUnit,
              multiplierNumerator: rule.multiplierNumerator,
              multiplierDenominator: rule.multiplierDenominator,
              stackPriority: rule.stackPriority,
              startsAt: rule.startsAt ? new Date(rule.startsAt) : null,
              endsAt: rule.endsAt ? new Date(rule.endsAt) : null,
              version: rule.version,
              active: rule.active,
            })),
            {
              name: campaign.freeEntryRule.name,
              ruleType: "AMOE_FIXED",
              targetType: "FREE_ENTRY",
              targetId: null,
              baseEntries: BigInt(campaign.freeEntryRule.entriesPerSubmission),
              entriesPerDollar: 1,
              multiplierNumerator: 1,
              multiplierDenominator: 1,
              stackPriority: campaign.freeEntryRule.stackPriority,
              startsAt: campaign.freeEntryRule.startsAt ? new Date(campaign.freeEntryRule.startsAt) : null,
              endsAt: campaign.freeEntryRule.endsAt ? new Date(campaign.freeEntryRule.endsAt) : null,
              version: campaign.freeEntryRule.version,
              active: campaign.freeEntryRule.active,
            },
          ],
        },
        multiplierSlots: {
          create: campaign.multiplierSchedule.map((slot) => ({
            label: slot.label,
            numerator: slot.numerator,
            denominator: slot.denominator,
            startsAt: new Date(slot.startsAt),
            endsAt: new Date(slot.endsAt),
          })),
        },
        membershipBands: {
          create: campaign.membershipEntryBands.map((band) => ({
            planId: planByProductSlug.get(band.planProductSlug)!.id,
            minimumSettledCycles: band.minimumSettledCycles,
            maximumSettledCycles: band.maximumSettledCycles,
            fixedEntries: BigInt(band.fixedEntries),
            multiplierNumerator: band.multiplierNumerator,
            multiplierDenominator: band.multiplierDenominator,
          })),
        },
      },
    });

    await tx.campaignApproval.createMany({
      data: [
        {
          tenantId: tenant.id,
          campaignId: created.id,
          kind: "SPONSOR_ADMIN_PUBLICATION",
          status: "APPROVED",
          configChecksum: "0".repeat(64),
          rulesChecksum: rules.checksum,
          approverId: actor.id,
          notes: "Published through the reviewed campaign overlay CLI.",
          evidenceRef: `campaign-config-sha256:${checksum}`,
          decidedAt: now,
        },
        {
          tenantId: tenant.id,
          campaignId: created.id,
          kind: "COMPLIANCE_WITNESS_PUBLICATION",
          status: "APPROVED",
          configChecksum: "0".repeat(64),
          rulesChecksum: rules.checksum,
          approverId: witness.id,
          notes: "Compliance witness attested to the exact campaign and Official Rules checksums.",
          evidenceRef: `official-rules-sha256:${rules.checksum}`,
          decidedAt: now,
        },
        ...campaign.operationalApprovals.map((approval) => ({
          tenantId: tenant.id,
          campaignId: created.id,
          kind: approval.kind,
          status: "APPROVED",
          configChecksum: "0".repeat(64),
          rulesChecksum: rules.checksum,
          approverId: approval.kind === "PRIZE_FUNDING" ? actor.id : witness.id,
          notes: approval.notes,
          evidenceRef: approval.evidenceRef,
          decidedAt: now,
        })),
      ],
    });
    const filingRows = campaign.filingDetermination.mode === "REQUIREMENTS"
      ? campaign.filingDetermination.requirements.map((requirement) => ({
          tenantId: tenant.id,
          campaignId: created.id,
          jurisdiction: requirement.jurisdiction.toUpperCase(),
          kind: requirement.kind,
          triggerReason: requirement.triggerReason,
          dueAt: requirement.dueAt ? new Date(requirement.dueAt) : null,
          status: requirement.status,
          evidenceRef: requirement.evidenceRef,
          waiverRationale: requirement.waiverRationale,
          approvedBy: witness.id,
          completedAt: new Date(requirement.completedAt),
        }))
      : [{
          tenantId: tenant.id,
          campaignId: created.id,
          jurisdiction: "COUNSEL_REVIEW",
          kind: "NO_FILINGS_REQUIRED",
          triggerReason: `Counsel reviewed: ${campaign.filingDetermination.reviewedJurisdictions.join(", ")}`,
          dueAt: null,
          status: "NOT_APPLICABLE",
          evidenceRef: campaign.filingDetermination.evidenceRef,
          waiverRationale: campaign.filingDetermination.rationale,
          approvedBy: witness.id,
          completedAt: now,
        }];
    await tx.filingRequirement.createMany({ data: filingRows });
    const release = await readCampaignReleaseManifest(tx, created.id);
    await tx.campaignApproval.updateMany({
      where: { campaignId: created.id },
      data: { configChecksum: release.checksum },
    });
    const published = await tx.campaign.update({
      where: { id: created.id },
      data: {
        status,
        configChecksum: release.checksum,
        releaseManifestJson: campaignReleaseManifestJson(release.manifest),
        approvedAt: now,
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: tenant.id,
        actorType: "ADMIN",
        actorId: actor.id,
        action: "CAMPAIGN_PUBLISHED",
        resourceType: "Campaign",
        resourceId: created.id,
        reason: "Approved campaign overlay publication",
        metadataJson: JSON.stringify({
          schemaVersion: overlay.schemaVersion,
          status,
          sourceOverlayChecksum: checksum,
          configChecksum: release.checksum,
          officialRulesVersion: campaign.officialRules.version,
          officialRulesChecksum: rules.checksum,
          complianceWitnessId: witness.id,
          membershipPlanProducts: requestedPlanSlugs,
          purchaseEntryCatalogVariants: catalogReadiness.purchasableVariantCount,
          operationalApprovalKinds: campaign.operationalApprovals.map((approval) => approval.kind),
          filingMode: campaign.filingDetermination.mode,
        }),
      },
    });
    return published;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  console.log(`Published ${result.code} as ${result.status}.`);
  console.log(`Campaign ID: ${result.id}`);
  console.log(`SHA-256: ${result.configChecksum}`);
}

async function main() {
  const command = process.argv[2];
  const file = process.argv[3];
  if (!command || !file || !["validate", "plan", "publish"].includes(command)) usage();
  const loaded = await loadOverlay(file);
  console.log(`Campaign configuration valid: ${loaded.overlay.campaign.title}`);
  console.log(`SHA-256: ${loaded.checksum}`);
  if (command === "validate") return;
  if (command === "plan") return printPlan(loaded.overlay, loaded.checksum);
  return publish(loaded.overlay, loaded.checksum);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
