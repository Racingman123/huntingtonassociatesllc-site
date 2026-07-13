import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import { db } from "@/server/db";
import { createStaff } from "./fixtures";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function buildOverlay(input: {
  tenantSlug: string;
  campaignSlug: string;
  campaignCode: string;
  rulesVersion: number;
  rulesChecksum: string;
  planProductSlug: string;
}) {
  return {
    schemaVersion: 1,
    targetTenantSlug: input.tenantSlug,
    campaign: {
      slug: input.campaignSlug,
      code: input.campaignCode,
      title: "Integration release campaign",
      eyebrow: "REVIEWED RELEASE",
      shortDescription: "A disposable campaign release integration test.",
      longDescription: "One verified winner receives the prize described by the exact published Official Rules.",
      kind: "SWEEPSTAKES",
      currency: "USD",
      timezone: "America/New_York",
      windows: {
        startsAt: "2035-06-01T00:00:00-04:00",
        purchaseEndsAt: "2035-07-01T23:59:59-04:00",
        freeEntryEndsAt: "2035-07-03T23:59:59-04:00",
        drawAt: "2035-07-10T12:00:00-04:00",
      },
      baseEntriesPerCurrencyUnit: 2,
      maxEntriesPerEntrant: "1000000",
      noPurchaseDisclosure: "NO PURCHASE NECESSARY. A PURCHASE WILL NOT INCREASE YOUR CHANCES OF WINNING.",
      eligibilitySummary: "Open to eligible U.S. residents age 18 or older; void where prohibited.",
      eligibility: {
        minimumAge: 18,
        eligibleCountries: ["US"],
        eligibleRegions: ["CO", "FL", "NY", "RI"],
        excludedRegions: ["AK", "HI"],
      },
      officialRules: {
        version: input.rulesVersion,
        checksum: input.rulesChecksum,
      },
      prizes: [{
        name: "Adventure package",
        description: "The single prize described in the governing Official Rules.",
        approximateValueCents: 15000000,
        currency: "USD",
        quantity: 1,
        cashAlternativeCents: null,
        image: "/demo/prizes/adventure-rig.svg",
        sortOrder: 0,
      }],
      purchaseEntryRules: [{
        name: "Standard purchase rate",
        targetType: "ALL" as "ALL" | "CATEGORY" | "COLLECTION" | "PRODUCT" | "VARIANT",
        targetId: null as string | null,
        entriesPerCurrencyUnit: 2,
        multiplierNumerator: 1,
        multiplierDenominator: 1,
        stackPriority: 0,
        startsAt: null as string | null,
        endsAt: null as string | null,
        version: 1,
        active: true,
      }],
      freeEntryRule: {
        name: "Online alternative method of entry",
        entriesPerSubmission: "1000",
        stackPriority: 100,
        startsAt: null,
        endsAt: null,
        version: 1,
        active: true,
      },
      multiplierSchedule: [
        {
          label: "Launch 20X",
          numerator: 20,
          denominator: 1,
          startsAt: "2035-06-01T00:00:00-04:00",
          endsAt: "2035-06-15T00:00:00-04:00",
        },
        {
          label: "Final 10X",
          numerator: 10,
          denominator: 1,
          startsAt: "2035-06-15T00:00:00-04:00",
          endsAt: "2035-07-01T23:59:59-04:00",
        },
      ],
      membershipEntryBands: [
        {
          planProductSlug: input.planProductSlug,
          minimumSettledCycles: 0,
          maximumSettledCycles: 2,
          fixedEntries: "25",
          multiplierNumerator: 2,
          multiplierDenominator: 1,
        },
        {
          planProductSlug: input.planProductSlug,
          minimumSettledCycles: 3,
          maximumSettledCycles: 5,
          fixedEntries: "30",
          multiplierNumerator: 2,
          multiplierDenominator: 1,
        },
        {
          planProductSlug: input.planProductSlug,
          minimumSettledCycles: 6,
          maximumSettledCycles: null,
          fixedEntries: "40",
          multiplierNumerator: 2,
          multiplierDenominator: 1,
        },
      ],
      operationalApprovals: [
        {
          kind: "LEGAL_RULES",
          evidenceRef: "test://approval/legal-rules-v7",
          notes: "Counsel approved the exact rules version, checksum, disclosures, and campaign release.",
        },
        {
          kind: "PRIZE_FUNDING",
          evidenceRef: "test://approval/prize-funding",
          notes: "The sponsor documented prize ownership, valuation, funding, and fulfillment capacity.",
        },
        {
          kind: "AMOE_PARITY",
          evidenceRef: "test://approval/amoe-parity",
          notes: "Counsel reviewed the alternative entry burden, timing, cap, and award parity.",
        },
        {
          kind: "DRAW_PROCEDURE",
          evidenceRef: "test://approval/draw-procedure",
          notes: "Compliance approved the snapshot, custody, random draw, and verification procedure.",
        },
        {
          kind: "ACCESSIBILITY",
          evidenceRef: "test://approval/accessibility",
          notes: "The complete participant journey received a documented accessibility review.",
        },
      ],
      filingDetermination: {
        mode: "REQUIREMENTS",
        requirements: [
          {
            jurisdiction: "fl",
            kind: "REGISTRATION_AND_BOND",
            triggerReason: "The announced prize value requires registration and security evidence before opening.",
            dueAt: "2035-05-24T17:00:00-04:00",
            status: "COMPLETED",
            evidenceRef: "test://filing/fl-registration",
            waiverRationale: null,
            completedAt: "2035-05-20T12:00:00-04:00",
          },
          {
            jurisdiction: "ri",
            kind: "RETAIL_GAME_REVIEW",
            triggerReason: "Counsel reviewed whether the sponsor and promotion trigger the retail filing rule.",
            dueAt: null,
            status: "NOT_APPLICABLE",
            evidenceRef: "test://filing/ri-counsel-memo",
            waiverRationale: "Counsel determined this promotion does not meet the reviewed retail-establishment trigger.",
            completedAt: "2035-05-20T12:00:00-04:00",
          },
        ],
      },
    },
  };
}

async function createReleaseFixture() {
  const marker = randomUUID().slice(0, 8);
  const tenant = await db.tenant.create({
    data: {
      slug: `release-${marker}`,
      displayName: "Campaign release tenant",
      legalName: "Campaign Release Integration LLC",
      supportEmail: `release-${marker}@example.test`,
      currency: "USD",
      timezone: "America/New_York",
    },
  });
  const rulesBody = "NO PURCHASE NECESSARY. Integration release Official Rules version 7.";
  const rules = await db.legalDocument.create({
    data: {
      tenantId: tenant.id,
      kind: "OFFICIAL_RULES",
      slug: "official-rules",
      title: "Official Rules",
      version: 7,
      body: rulesBody,
      checksum: sha256(rulesBody),
      status: "PUBLISHED",
      effectiveAt: new Date("2035-05-01T00:00:00-04:00"),
    },
  });
  const product = await db.product.create({
    data: {
      tenantId: tenant.id,
      slug: `membership-${marker}`,
      title: "Integration membership",
      description: "A disposable recurring membership plan.",
      productType: "MEMBERSHIP",
      status: "ACTIVE",
      category: "Membership",
      priceCents: 2500,
      image: "/demo/products/membership.svg",
      inventory: 1000,
    },
  });
  const plan = await db.subscriptionPlan.create({
    data: {
      tenantId: tenant.id,
      productId: product.id,
      name: "Integration membership",
      status: "ACTIVE",
      interval: "MONTH",
      intervalCount: 1,
      priceCents: 2500,
      currency: "USD",
      baseEntries: 25n,
    },
  });
  const catalogProduct = await db.product.create({
    data: {
      tenantId: tenant.id,
      slug: `gear-${marker}`,
      title: "Integration gear",
      description: "A disposable ordinary checkout product.",
      productType: "PHYSICAL",
      status: "ACTIVE",
      category: "Gear",
      priceCents: 5000,
      image: "/demo/products/roadside-kit.svg",
      inventory: 10,
      variants: {
        create: {
          tenantId: tenant.id,
          sku: `GEAR-${marker.toUpperCase()}`,
          title: "Default",
          inventory: 10,
          status: "ACTIVE",
        },
      },
    },
    include: { variants: true },
  });
  const [actor, witness] = await Promise.all([
    createStaff(tenant.id, "ADMIN"),
    createStaff(tenant.id, "COMPLIANCE"),
  ]);
  return { tenant, rules, product, plan, catalogProduct, actor, witness, marker };
}

function runPublisher(input: {
  overlay: unknown;
  actorId: string;
  witnessId: string;
}) {
  const directory = mkdtempSync(join(tmpdir(), "campaign-release-cli-"));
  const configPath = join(directory, "campaign.json");
  writeFileSync(configPath, JSON.stringify(input.overlay));
  try {
    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "scripts/campaign.ts",
      "publish",
      configPath,
      "--actor",
      input.actorId,
      "--witness",
      input.witnessId,
      "--confirm",
    ], {
      cwd: resolve(import.meta.dirname, "../.."),
      env: process.env,
      encoding: "utf8",
      timeout: 20_000,
    });
    if (result.error) throw result.error;
    return {
      status: result.status,
      output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runPlan(overlay: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "campaign-plan-cli-"));
  const configPath = join(directory, "campaign.json");
  writeFileSync(configPath, JSON.stringify(overlay));
  try {
    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "scripts/campaign.ts",
      "plan",
      configPath,
    ], {
      cwd: resolve(import.meta.dirname, "../.."),
      env: process.env,
      encoding: "utf8",
      timeout: 20_000,
    });
    if (result.error) throw result.error;
    return {
      status: result.status,
      output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

afterAll(async () => {
  await db.$disconnect();
});

describe.sequential("campaign release publisher", () => {
  test("atomically persists bands, release approvals, filings, and the exact Official Rules relation", async () => {
    const fixture = await createReleaseFixture();
    const overlay = buildOverlay({
      tenantSlug: fixture.tenant.slug,
      campaignSlug: `campaign-${fixture.marker}`,
      campaignCode: `RELEASE-${fixture.marker}`,
      rulesVersion: fixture.rules.version,
      rulesChecksum: fixture.rules.checksum,
      planProductSlug: fixture.product.slug,
    });

    const result = runPublisher({
      overlay,
      actorId: fixture.actor.id,
      witnessId: fixture.witness.id,
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(/Published .* as SCHEDULED/i);

    const campaign = await db.campaign.findUniqueOrThrow({
      where: {
        tenantId_slug: {
          tenantId: fixture.tenant.id,
          slug: overlay.campaign.slug,
        },
      },
      include: {
        officialRulesDocument: true,
        membershipBands: {
          include: { plan: { include: { product: true } } },
          orderBy: { minimumSettledCycles: "asc" },
        },
        approvals: { orderBy: { kind: "asc" } },
        filingRequirements: { orderBy: { jurisdiction: "asc" } },
      },
    });
    expect(campaign).toMatchObject({
      status: "SCHEDULED",
      rulesVersion: fixture.rules.version,
      officialRulesDocumentId: fixture.rules.id,
      officialRulesChecksum: fixture.rules.checksum,
    });
    expect(campaign.officialRulesDocument).toMatchObject({
      id: fixture.rules.id,
      version: fixture.rules.version,
      checksum: fixture.rules.checksum,
      status: "PUBLISHED",
    });
    expect(campaign.configChecksum).toMatch(/^[a-f0-9]{64}$/);

    expect(campaign.membershipBands.map((band) => ({
      productSlug: band.plan.product.slug,
      minimumSettledCycles: band.minimumSettledCycles,
      maximumSettledCycles: band.maximumSettledCycles,
      fixedEntries: band.fixedEntries,
      multiplier: [band.multiplierNumerator, band.multiplierDenominator],
    }))).toEqual([
      { productSlug: fixture.product.slug, minimumSettledCycles: 0, maximumSettledCycles: 2, fixedEntries: 25n, multiplier: [2, 1] },
      { productSlug: fixture.product.slug, minimumSettledCycles: 3, maximumSettledCycles: 5, fixedEntries: 30n, multiplier: [2, 1] },
      { productSlug: fixture.product.slug, minimumSettledCycles: 6, maximumSettledCycles: null, fixedEntries: 40n, multiplier: [2, 1] },
    ]);

    const requiredOperationalKinds = [
      "ACCESSIBILITY",
      "AMOE_PARITY",
      "DRAW_PROCEDURE",
      "LEGAL_RULES",
      "PRIZE_FUNDING",
    ];
    expect(campaign.approvals).toHaveLength(7);
    expect(campaign.approvals.filter((approval) => requiredOperationalKinds.includes(approval.kind))).toHaveLength(5);
    expect(campaign.approvals.every((approval) => (
      approval.status === "APPROVED"
      && approval.configChecksum === campaign.configChecksum
      && approval.rulesChecksum === fixture.rules.checksum
      && Boolean(approval.evidenceRef)
      && Boolean(approval.decidedAt)
    ))).toBe(true);
    expect(campaign.approvals.find((approval) => approval.kind === "PRIZE_FUNDING")?.approverId).toBe(fixture.actor.id);
    for (const approval of campaign.approvals.filter((item) => requiredOperationalKinds.includes(item.kind) && item.kind !== "PRIZE_FUNDING")) {
      expect(approval.approverId).toBe(fixture.witness.id);
    }

    expect(campaign.filingRequirements).toEqual([
      expect.objectContaining({
        jurisdiction: "FL",
        kind: "REGISTRATION_AND_BOND",
        status: "COMPLETED",
        evidenceRef: "test://filing/fl-registration",
        waiverRationale: null,
        approvedBy: fixture.witness.id,
      }),
      expect.objectContaining({
        jurisdiction: "RI",
        kind: "RETAIL_GAME_REVIEW",
        status: "NOT_APPLICABLE",
        evidenceRef: "test://filing/ri-counsel-memo",
        waiverRationale: expect.stringMatching(/does not meet/i),
        approvedBy: fixture.witness.id,
      }),
    ]);
  }, 60_000);

  test("fails closed for a missing plan, missing evidence, currency drift, or non-exact rules checksum", async () => {
    const fixture = await createReleaseFixture();
    const base = buildOverlay({
      tenantSlug: fixture.tenant.slug,
      campaignSlug: `failure-${fixture.marker}`,
      campaignCode: `FAIL-${fixture.marker}`,
      rulesVersion: fixture.rules.version,
      rulesChecksum: fixture.rules.checksum,
      planProductSlug: fixture.product.slug,
    });
    const publish = (overlay: unknown) => runPublisher({
      overlay,
      actorId: fixture.actor.id,
      witnessId: fixture.witness.id,
    });

    const missingPlan = structuredClone(base);
    missingPlan.campaign.membershipEntryBands.forEach((band) => {
      band.planProductSlug = "missing-membership-plan";
    });
    const missingPlanResult = publish(missingPlan);
    expect(missingPlanResult.status).not.toBe(0);
    expect(missingPlanResult.output).toMatch(/membership plan product 'missing-membership-plan'.*not found/i);

    const missingEvidence = structuredClone(base);
    missingEvidence.campaign.operationalApprovals[0]!.evidenceRef = "";
    const missingEvidenceResult = publish(missingEvidence);
    expect(missingEvidenceResult.status).not.toBe(0);
    expect(missingEvidenceResult.output).toMatch(/evidenceRef|too_small|at least 5/i);

    const currencyDrift = structuredClone(base);
    currencyDrift.campaign.currency = "EUR";
    currencyDrift.campaign.prizes[0]!.currency = "EUR";
    const currencyResult = publish(currencyDrift);
    expect(currencyResult.status).not.toBe(0);
    expect(currencyResult.output).toMatch(/campaign currency EUR does not match tenant currency USD/i);

    const mismatchedRules = structuredClone(base);
    mismatchedRules.campaign.officialRules.checksum = sha256("different published rules");
    const rulesResult = publish(mismatchedRules);
    expect(rulesResult.status).not.toBe(0);
    expect(rulesResult.output).toMatch(/exact Official Rules version\/checksum must be published/i);

    const unresolvedTarget = structuredClone(base);
    unresolvedTarget.campaign.purchaseEntryRules[0]!.targetType = "PRODUCT";
    unresolvedTarget.campaign.purchaseEntryRules[0]!.targetId = "missing-catalog-product";
    const unresolvedPlan = runPlan(unresolvedTarget);
    expect(unresolvedPlan.status, unresolvedPlan.output).toBe(0);
    expect(unresolvedPlan.output).toMatch(/"purchaseEntryCatalog"[\s\S]*"ready": false/i);
    expect(unresolvedPlan.output).toMatch(/does not resolve to an active purchasable non-membership variant/i);
    expect(unresolvedPlan.output).toMatch(/"publishReady": false/i);
    const unresolvedResult = publish(unresolvedTarget);
    expect(unresolvedResult.status).not.toBe(0);
    expect(unresolvedResult.output).toMatch(/purchase-entry catalog is not publishable.*does not resolve/i);

    const coverageGap = structuredClone(base);
    coverageGap.campaign.purchaseEntryRules[0]!.startsAt = "2035-06-02T00:00:00-04:00";
    const coverageResult = publish(coverageGap);
    expect(coverageResult.status).not.toBe(0);
    expect(coverageResult.output).toMatch(/purchase-entry catalog is not publishable.*has no active purchase-entry rule/i);

    const malformedBodyChecksum = "a".repeat(64);
    await db.legalDocument.create({
      data: {
        tenantId: fixture.tenant.id,
        kind: "OFFICIAL_RULES",
        slug: "official-rules",
        title: "Malformed imported Official Rules",
        version: 8,
        body: "NO PURCHASE NECESSARY. This body does not match its imported checksum.",
        checksum: malformedBodyChecksum,
        status: "PUBLISHED",
        effectiveAt: new Date("2035-05-01T00:00:00-04:00"),
      },
    });
    const malformedRules = structuredClone(base);
    malformedRules.campaign.officialRules.version = 8;
    malformedRules.campaign.officialRules.checksum = malformedBodyChecksum;
    const malformedRulesPlan = runPlan(malformedRules);
    expect(malformedRulesPlan.status, malformedRulesPlan.output).toBe(0);
    expect(malformedRulesPlan.output).toMatch(/"publishedBodyMatchesStoredChecksum": false/i);
    expect(malformedRulesPlan.output).toMatch(/"publishReady": false/i);
    const malformedRulesResult = publish(malformedRules);
    expect(malformedRulesResult.status).not.toBe(0);
    expect(malformedRulesResult.output).toMatch(/exact Official Rules version\/checksum must be published/i);

    await db.product.create({
      data: {
        tenantId: fixture.tenant.id,
        slug: `no-variant-${fixture.marker}`,
        title: "Active product without an option",
        description: "This incomplete catalog row must block campaign publication.",
        productType: "DIGITAL",
        status: "ACTIVE",
        category: "Gear",
        priceCents: 1000,
        image: "/demo/products/pass-bronze.svg",
      },
    });
    const zeroVariantPlan = runPlan(base);
    expect(zeroVariantPlan.status, zeroVariantPlan.output).toBe(0);
    expect(zeroVariantPlan.output).toMatch(/has no active purchasable variant/i);
    expect(zeroVariantPlan.output).toMatch(/"publishReady": false/i);
    const zeroVariantResult = publish(base);
    expect(zeroVariantResult.status).not.toBe(0);
    expect(zeroVariantResult.output).toMatch(/purchase-entry catalog is not publishable.*has no active purchasable variant/i);

    expect(await db.campaign.count({ where: { tenantId: fixture.tenant.id } })).toBe(0);
    expect(await db.membershipEntryBand.count({
      where: { campaign: { tenantId: fixture.tenant.id } },
    })).toBe(0);
    expect(await db.campaignApproval.count({ where: { tenantId: fixture.tenant.id } })).toBe(0);
    expect(await db.filingRequirement.count({ where: { tenantId: fixture.tenant.id } })).toBe(0);
  }, 60_000);
});
