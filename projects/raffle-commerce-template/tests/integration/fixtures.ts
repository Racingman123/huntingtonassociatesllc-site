import { createHash, randomUUID } from "node:crypto";
import { db } from "@/server/db";
import {
  campaignReleaseManifestJson,
  readCampaignReleaseManifest,
  requiredCampaignApprovalKinds,
} from "@/server/campaigns/integrity";

const HOUR = 60 * 60 * 1000;

function marker(prefix: string) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function createPromotion(options: {
  status?: string;
  multiplier?: number;
  baseEntriesPerDollar?: number;
  amoeEntries?: bigint;
  maxEntries?: bigint | null;
  closed?: boolean;
  drawReady?: boolean;
} = {}) {
  const id = marker("promotion");
  const now = Date.now();
  const closed = options.closed ?? false;
  const startsAt = new Date(now - (closed ? 72 : 24) * HOUR);
  const endsAt = new Date(now + (closed ? -24 : 48) * HOUR);
  const tenant = await db.tenant.create({
    data: {
      slug: id,
      displayName: `Test ${id}`,
      legalName: `Test ${id} LLC`,
      supportEmail: `${id}@example.test`,
      currency: "USD",
      timezone: "America/New_York",
    },
  });
  // Every released promotion must bind a real ordinary checkout catalog. Most
  // integration tests do not care which product is present, so provide one
  // covered option before the campaign is created and later finalized.
  await createProduct({ tenantId: tenant.id });
  const rulesBody = "NO PURCHASE NECESSARY. Integration test rules.";
  const rules = await db.legalDocument.create({
    data: {
      tenantId: tenant.id,
      kind: "OFFICIAL_RULES",
      slug: "official-rules",
      title: "Official Rules",
      version: 1,
      body: rulesBody,
      checksum: sha256(rulesBody),
      status: "PUBLISHED",
      effectiveAt: startsAt,
    },
  });
  const campaign = await db.campaign.create({
    data: {
      tenantId: tenant.id,
      slug: id,
      code: id.toUpperCase(),
      title: `Test campaign ${id}`,
      shortDescription: "Integration-test campaign",
      longDescription: "A disposable promotion used only by the integration suite.",
      status: options.status ?? (closed ? "ENTRY_CLOSED" : "LIVE"),
      startsAt,
      endsAt,
      freeEntryEndsAt: endsAt,
      drawAt: options.drawReady ? new Date(now - HOUR) : new Date(now + 72 * HOUR),
      baseEntriesPerDollar: options.baseEntriesPerDollar ?? 1,
      currentMultiplier: options.multiplier ?? 10,
      maxEntriesPerEntrant: options.maxEntries === undefined ? 1_000_000n : options.maxEntries,
      eligibilitySummary: "Test residents age 18+; void where prohibited.",
      rulesVersion: rules.version,
      officialRulesDocumentId: rules.id,
      officialRulesChecksum: rules.checksum,
      configChecksum: sha256(id),
      // Tests may advance a campaign's clock before explicitly finalizing its
      // immutable release with releasePromotionFixture().
      approvedAt: null,
      entryRules: {
        create: [
          {
            name: "All purchase products",
            ruleType: "MONEY_RATE",
            targetType: "ALL",
            entriesPerDollar: 1,
            stackPriority: 0,
          },
          ...(options.amoeEntries === 0n ? [] : [{
            name: "Free online entry",
            ruleType: "AMOE_FIXED",
            targetType: "FREE_ENTRY",
            baseEntries: options.amoeEntries ?? 25_000n,
            stackPriority: 100,
          }]),
        ],
      },
    },
  });
  return { tenant, campaign, rules };
}

export async function releasePromotionFixture(campaignId: string) {
  const existing = await db.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { approvals: true, entryRules: true, filingRequirements: true, prizes: true },
  });
  if (existing.approvedAt) return existing;
  const placeholder = "0".repeat(64);
  const decidedAt = new Date(existing.startsAt.getTime() - HOUR);
  if (existing.prizes.length === 0) {
    await db.campaignPrize.create({
      data: {
        tenantId: existing.tenantId,
        campaignId,
        name: "Integration release prize",
        description: "Single disposable prize used to finalize an integration campaign release.",
        approximateValueCents: 100_000,
        currency: "USD",
        quantity: 1,
      },
    });
  }
  if (!existing.entryRules.some((rule) => rule.ruleType === "MONEY_RATE")) {
    await db.entryRule.create({
      data: {
        campaignId,
        name: "Integration fixture ordinary purchase coverage",
        ruleType: "MONEY_RATE",
        targetType: "ALL",
        entriesPerDollar: 1,
        stackPriority: 0,
      },
    });
  }
  if (!existing.entryRules.some((rule) => rule.ruleType === "AMOE_FIXED")) {
    await db.entryRule.create({
      data: {
        campaignId,
        name: "Integration fixture free online entry",
        ruleType: "AMOE_FIXED",
        targetType: "FREE_ENTRY",
        baseEntries: 1000n,
        stackPriority: 100,
      },
    });
  }
  if (existing.approvals.length === 0) {
    await db.campaignApproval.createMany({
      data: requiredCampaignApprovalKinds.map((kind) => ({
        tenantId: existing.tenantId,
        campaignId,
        kind,
        status: "APPROVED",
        configChecksum: placeholder,
        rulesChecksum: existing.officialRulesChecksum,
        approverId: kind === "SPONSOR_ADMIN_PUBLICATION" || kind === "PRIZE_FUNDING"
          ? `fixture-sponsor-${campaignId}`
          : `fixture-compliance-${campaignId}`,
        notes: `Integration fixture approval for the exact ${kind} release evidence.`,
        evidenceRef: `test://campaign-release/${kind.toLowerCase()}/${campaignId}`,
        decidedAt,
      })),
    });
  }
  if (existing.filingRequirements.length === 0) {
    await db.filingRequirement.create({
      data: {
        tenantId: existing.tenantId,
        campaignId,
        jurisdiction: "COUNSEL_REVIEW",
        kind: "NO_FILINGS_REQUIRED",
        triggerReason: "Integration fixture counsel review covered the disposable test jurisdiction.",
        status: "NOT_APPLICABLE",
        evidenceRef: `test://filing-review/${campaignId}`,
        waiverRationale: "Disposable integration fixture only; no public promotion or filing is made.",
        approvedBy: `fixture-compliance-${campaignId}`,
        completedAt: decidedAt,
      },
    });
  }
  const release = await readCampaignReleaseManifest(db, campaignId);
  await db.campaignApproval.updateMany({
    where: { campaignId },
    data: { configChecksum: release.checksum },
  });
  return db.campaign.update({
    where: { id: campaignId },
    data: {
      configChecksum: release.checksum,
      releaseManifestJson: campaignReleaseManifestJson(release.manifest),
      approvedAt: decidedAt,
    },
  });
}

export async function createProduct(input: {
  tenantId: string;
  priceCents?: number;
  entryMultiplier?: number;
  productType?: string;
  category?: string;
  inventory?: number;
}) {
  const id = marker("product");
  const inventory = input.inventory ?? 50;
  return db.product.create({
    data: {
      tenantId: input.tenantId,
      slug: id,
      title: `Test product ${id}`,
      description: "Disposable integration-test product.",
      productType: input.productType ?? "DIGITAL",
      status: "ACTIVE",
      category: input.category ?? "Test",
      priceCents: input.priceCents ?? 10_000,
      image: "/demo/products/pass-bronze.svg",
      entryMultiplier: input.entryMultiplier ?? 1,
      inventory,
      variants: {
        create: {
          tenantId: input.tenantId,
          sku: id.toUpperCase(),
          title: "Default",
          inventory,
          status: "ACTIVE",
        },
      },
    },
    include: { variants: true },
  });
}

export async function createEntrantAccount(input: {
  tenantId: string;
  campaignId: string;
  status?: string;
  balance?: bigint;
  email?: string;
}) {
  const id = marker("entrant");
  const email = input.email ?? `${id}@example.test`;
  const entrant = await db.entrant.create({
    data: {
      tenantId: input.tenantId,
      normalizedEmail: email.toLowerCase(),
      emailHash: sha256(email.toLowerCase()),
      name: `Entrant ${id}`,
      phone: "+13035550148",
      region: "CO",
      postalCode: "80202",
      eligibilityAttested: true,
    },
  });
  await db.campaignEntrant.create({
    data: {
      campaignId: input.campaignId,
      entrantId: entrant.id,
      status: input.status ?? "ELIGIBLE",
    },
  });
  const account = await db.entryAccount.create({
    data: {
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      entrantId: entrant.id,
    },
  });
  const balance = input.balance ?? 0n;
  if (balance > 0n) {
    await db.entryLedgerEvent.create({
      data: {
        tenantId: input.tenantId,
        entryAccountId: account.id,
        kind: "GRANT",
        delta: balance,
        idempotencyKey: `fixture-grant:${account.id}`,
        effectiveAt: new Date(),
        reasonCode: "INTEGRATION_FIXTURE",
      },
    });
    await db.entryAccount.update({ where: { id: account.id }, data: { balance, version: 1 } });
  }
  return { entrant, account: { ...account, balance } };
}

export async function createStaff(tenantId: string, role: "ADMIN" | "OPERATIONS" | "COMPLIANCE") {
  const id = marker(role.toLowerCase());
  return db.user.create({
    data: {
      tenantId,
      email: `${id}@example.test`,
      normalizedEmail: `${id}@example.test`,
      name: `${role} Test User`,
      passwordHash: "not-used-by-service-tests",
      role,
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    },
  });
}

export function checkoutInput(input: {
  email: string;
  lines: Array<{ productId: string; variantId: string; quantity: number }>;
  idempotencyKey?: string;
}) {
  return {
    email: input.email,
    name: "Integration Entrant",
    phone: "+1 (303) 555-0148",
    address1: "100 Test Trail",
    city: "Denver",
    region: "CO",
    postalCode: "80202",
    country: "US" as const,
    ageConfirmed: true as const,
    rulesAccepted: true as const,
    marketingConsent: false,
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
    lines: input.lines,
  };
}

export function freeEntryInput(campaignSlug: string, email: string) {
  return {
    campaignSlug,
    email,
    name: "Free Entry Tester",
    phone: "+1 303.555.0148",
    region: "CO",
    postalCode: "80202",
    country: "US" as const,
    ageConfirmed: true as const,
    residenceConfirmed: true as const,
    rulesAccepted: true as const,
    website: "",
  };
}
