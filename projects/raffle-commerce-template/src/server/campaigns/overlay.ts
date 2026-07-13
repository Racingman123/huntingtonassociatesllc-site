import { createHash } from "node:crypto";
import { z } from "zod";
import { isTwoDecimalCurrency } from "@/lib/format";
import { campaignEligibilityOptions } from "./eligibility";

const slug = z.string().trim().min(1).max(100).regex(
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  "Use lowercase words separated by hyphens",
);
const timestamp = z.string().trim().refine((value) => (
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value))
), "Use an RFC 3339 timestamp with an explicit UTC offset");
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).refine(
  isTwoDecimalCurrency,
  "Use an ISO currency with exactly two minor-unit digits",
);
const positiveBigIntString = z.string().trim().regex(/^[1-9]\d*$/, "Use a positive whole number").refine(
  (value) => {
    try {
      return BigInt(value) <= BigInt("9223372036854775807");
    } catch {
      return false;
    }
  },
  "Value exceeds the signed 64-bit database limit",
);
const publicAssetPath = z.union([
  z.literal(""),
  z.string().trim().max(500).refine((value) => (
    value.startsWith("/")
    && !value.startsWith("//")
    && !value.split("/").includes("..")
  ), "Use a root-relative public asset path without traversal segments"),
]);
const sha256Checksum = z.string().trim().toLowerCase().regex(
  /^[a-f0-9]{64}$/,
  "Use the exact 64-character SHA-256 checksum of the published document",
);
const evidenceRef = z.string().trim().min(5).max(500);

export const requiredOperationalApprovalKinds = [
  "LEGAL_RULES",
  "PRIZE_FUNDING",
  "AMOE_PARITY",
  "DRAW_PROCEDURE",
  "ACCESSIBILITY",
] as const;

const prizeSchema = z.object({
  name: z.string().trim().min(1).max(180),
  description: z.string().trim().min(1).max(2_000),
  approximateValueCents: z.number().int().positive().max(2_000_000_000),
  currency,
  quantity: z.number().int().positive().max(1_000).default(1),
  cashAlternativeCents: z.number().int().nonnegative().max(2_000_000_000).nullable().default(null),
  image: publicAssetPath.default(""),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
}).strict();

const purchaseEntryRuleSchema = z.object({
  name: z.string().trim().min(1).max(160),
  targetType: z.enum(["ALL", "CATEGORY", "COLLECTION", "PRODUCT", "VARIANT"]),
  targetId: z.string().trim().min(1).max(180).nullable().default(null),
  entriesPerCurrencyUnit: z.number().int().positive().max(1_000_000),
  multiplierNumerator: z.number().int().positive().max(1_000_000).default(1),
  multiplierDenominator: z.number().int().positive().max(1_000_000).default(1),
  stackPriority: z.number().int().min(-10_000).max(10_000).default(0),
  startsAt: timestamp.nullable().default(null),
  endsAt: timestamp.nullable().default(null),
  version: z.number().int().positive().max(1_000_000).default(1),
  active: z.boolean().default(true),
}).strict().superRefine((rule, context) => {
  if (rule.targetType === "ALL" && rule.targetId !== null) {
    context.addIssue({ code: "custom", path: ["targetId"], message: "ALL rules must not specify targetId" });
  }
  if (rule.targetType !== "ALL" && !rule.targetId) {
    context.addIssue({ code: "custom", path: ["targetId"], message: `${rule.targetType} rules require targetId` });
  }
  if (rule.multiplierNumerator % rule.multiplierDenominator !== 0) {
    context.addIssue({
      code: "custom",
      path: ["multiplierDenominator"],
      message: "Purchase-rule multipliers must resolve to an integral factor",
    });
  }
  if (rule.startsAt && rule.endsAt && Date.parse(rule.startsAt) >= Date.parse(rule.endsAt)) {
    context.addIssue({ code: "custom", path: ["endsAt"], message: "Rule endsAt must follow startsAt" });
  }
});

const freeEntryRuleSchema = z.object({
  name: z.string().trim().min(1).max(160),
  entriesPerSubmission: positiveBigIntString,
  stackPriority: z.number().int().min(-10_000).max(10_000).default(100),
  startsAt: timestamp.nullable().default(null),
  endsAt: timestamp.nullable().default(null),
  version: z.number().int().positive().max(1_000_000).default(1),
  active: z.boolean(),
}).strict();

const multiplierPeriodSchema = z.object({
  label: z.string().trim().min(1).max(160),
  numerator: z.number().int().positive().max(1_000_000),
  denominator: z.number().int().positive().max(1_000_000).default(1),
  startsAt: timestamp,
  endsAt: timestamp,
}).strict();

const membershipEntryBandSchema = z.object({
  planProductSlug: slug,
  minimumSettledCycles: z.number().int().nonnegative().max(10_000),
  maximumSettledCycles: z.number().int().nonnegative().max(10_000).nullable(),
  fixedEntries: positiveBigIntString,
  multiplierNumerator: z.number().int().positive().max(1_000_000).default(1),
  multiplierDenominator: z.number().int().positive().max(1_000_000).default(1),
}).strict().superRefine((band, context) => {
  if (band.maximumSettledCycles !== null && band.maximumSettledCycles < band.minimumSettledCycles) {
    context.addIssue({
      code: "custom",
      path: ["maximumSettledCycles"],
      message: "Maximum settled cycles cannot precede the minimum",
    });
  }
  if (
    (BigInt(band.fixedEntries) * BigInt(band.multiplierNumerator))
    % BigInt(band.multiplierDenominator) !== 0n
  ) {
    context.addIssue({
      code: "custom",
      path: ["multiplierDenominator"],
      message: "Membership band must resolve to an integral entry grant",
    });
  }
});

const operationalApprovalSchema = z.object({
  kind: z.enum(requiredOperationalApprovalKinds),
  evidenceRef,
  notes: z.string().trim().min(20).max(2_000),
}).strict();

const filingRequirementSchema = z.object({
  jurisdiction: z.string().trim().min(1).max(80),
  kind: z.string().trim().min(1).max(120),
  triggerReason: z.string().trim().min(20).max(2_000),
  dueAt: timestamp.nullable(),
  status: z.enum(["COMPLETED", "NOT_APPLICABLE"]),
  evidenceRef,
  waiverRationale: z.string().trim().min(20).max(2_000).nullable(),
  completedAt: timestamp,
}).strict().superRefine((requirement, context) => {
  if (requirement.status === "COMPLETED" && requirement.waiverRationale !== null) {
    context.addIssue({
      code: "custom",
      path: ["waiverRationale"],
      message: "A completed filing must not include a waiver rationale",
    });
  }
  if (requirement.status === "NOT_APPLICABLE" && !requirement.waiverRationale) {
    context.addIssue({
      code: "custom",
      path: ["waiverRationale"],
      message: "A not-applicable determination requires counsel's rationale",
    });
  }
});

const filingDeterminationSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("REQUIREMENTS"),
    requirements: z.array(filingRequirementSchema).min(1).max(300),
  }).strict(),
  z.object({
    mode: z.literal("NO_FILINGS_REQUIRED"),
    reviewedJurisdictions: z.array(z.string().trim().min(1).max(80)).min(1).max(300),
    rationale: z.string().trim().min(20).max(4_000),
    evidenceRef,
  }).strict(),
]);

export const campaignOverlaySchema = z.object({
  schemaVersion: z.literal(1),
  targetTenantSlug: slug,
  campaign: z.object({
    slug,
    code: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    title: z.string().trim().min(1).max(180),
    eyebrow: z.string().trim().max(160).nullable().default(null),
    shortDescription: z.string().trim().min(1).max(500),
    longDescription: z.string().trim().min(1).max(10_000),
    kind: z.enum(["SWEEPSTAKES", "GIVEAWAY"]),
    currency,
    timezone: z.string().trim().min(1).max(100).refine((value) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
        return true;
      } catch {
        return false;
      }
    }, "Use an IANA timezone such as America/New_York"),
    windows: z.object({
      startsAt: timestamp,
      purchaseEndsAt: timestamp,
      freeEntryEndsAt: timestamp,
      drawAt: timestamp,
    }).strict(),
    baseEntriesPerCurrencyUnit: z.number().int().positive().max(1_000_000),
    maxEntriesPerEntrant: positiveBigIntString,
    noPurchaseDisclosure: z.string().trim().min(20).max(1_000),
    eligibilitySummary: z.string().trim().min(1).max(1_000),
    eligibility: z.object({
      minimumAge: z.number().int().min(18).max(120),
      eligibleCountries: z.array(z.string().trim().toUpperCase()).min(1).max(300),
      eligibleRegions: z.array(z.string().trim().toUpperCase()).max(300),
      excludedRegions: z.array(z.string().trim().toUpperCase()).max(300),
    }).strict(),
    officialRules: z.object({
      version: z.number().int().positive().max(1_000_000),
      checksum: sha256Checksum,
    }).strict(),
    prizes: z.array(prizeSchema).min(1).max(100),
    purchaseEntryRules: z.array(purchaseEntryRuleSchema).min(1).max(100),
    freeEntryRule: freeEntryRuleSchema,
    multiplierSchedule: z.array(multiplierPeriodSchema).min(1).max(1_000),
    membershipEntryBands: z.array(membershipEntryBandSchema).max(300).default([]),
    operationalApprovals: z.array(operationalApprovalSchema).length(requiredOperationalApprovalKinds.length),
    filingDetermination: filingDeterminationSchema,
  }).strict(),
}).strict().superRefine((overlay, context) => {
  const campaign = overlay.campaign;
  const start = Date.parse(campaign.windows.startsAt);
  const purchaseEnd = Date.parse(campaign.windows.purchaseEndsAt);
  const freeEnd = Date.parse(campaign.windows.freeEntryEndsAt);
  const draw = Date.parse(campaign.windows.drawAt);

  if (start >= purchaseEnd) {
    context.addIssue({ code: "custom", path: ["campaign", "windows", "purchaseEndsAt"], message: "Purchase entry must end after campaign start" });
  }
  if (start >= freeEnd) {
    context.addIssue({ code: "custom", path: ["campaign", "windows", "freeEntryEndsAt"], message: "Free entry must end after campaign start" });
  }
  if (draw <= Math.max(purchaseEnd, freeEnd)) {
    context.addIssue({ code: "custom", path: ["campaign", "windows", "drawAt"], message: "Draw must follow both entry cutoffs" });
  }
  if (!/NO\s+PURCHASE\s+NECESSARY/i.test(campaign.noPurchaseDisclosure)) {
    context.addIssue({ code: "custom", path: ["campaign", "noPurchaseDisclosure"], message: "Disclosure must state that no purchase is necessary" });
  }
  if (!/PURCHASE[\s\S]{0,100}(?:WILL\s+NOT|DOES\s+NOT)[\s\S]{0,100}INCREASE[\s\S]{0,50}CHANCE/i.test(campaign.noPurchaseDisclosure)) {
    context.addIssue({ code: "custom", path: ["campaign", "noPurchaseDisclosure"], message: "Disclosure must state that a purchase does not increase the chance of winning" });
  }

  for (const [index, prize] of campaign.prizes.entries()) {
    if (prize.currency !== campaign.currency) {
      context.addIssue({ code: "custom", path: ["campaign", "prizes", index, "currency"], message: "Prize currency must match campaign and tenant currency" });
    }
  }
  if (campaign.prizes.length !== 1 || campaign.prizes[0]?.quantity !== 1) {
    context.addIssue({
      code: "custom",
      path: ["campaign", "prizes"],
      message: "This template draw workflow requires exactly one prize with quantity 1",
    });
  }

  if (!campaign.purchaseEntryRules.some((rule) => rule.active)) {
    context.addIssue({ code: "custom", path: ["campaign", "purchaseEntryRules"], message: "At least one purchase-entry rule must be active" });
  }
  const activePriorities = new Set<number>();
  for (const [index, rule] of campaign.purchaseEntryRules.entries()) {
    if (!rule.active) continue;
    if (activePriorities.has(rule.stackPriority)) {
      context.addIssue({
        code: "custom",
        path: ["campaign", "purchaseEntryRules", index, "stackPriority"],
        message: "Active purchase rules must use distinct priorities so matching can never be ambiguous",
      });
    }
    activePriorities.add(rule.stackPriority);
    const ruleStart = rule.startsAt ? Date.parse(rule.startsAt) : start;
    const ruleEnd = rule.endsAt ? Date.parse(rule.endsAt) : purchaseEnd;
    if (ruleStart < start || ruleEnd > purchaseEnd || ruleStart >= ruleEnd) {
      context.addIssue({
        code: "custom",
        path: ["campaign", "purchaseEntryRules", index],
        message: "Active purchase-rule dates must form a positive interval within the purchase window",
      });
    }
  }

  const freeRule = campaign.freeEntryRule;
  const freeRuleStart = freeRule.startsAt ? Date.parse(freeRule.startsAt) : start;
  const freeRuleEnd = freeRule.endsAt ? Date.parse(freeRule.endsAt) : freeEnd;
  if (!freeRule.active) {
    context.addIssue({ code: "custom", path: ["campaign", "freeEntryRule", "active"], message: "The free-entry rule must be active" });
  }
  if (freeRuleStart > start || freeRuleEnd < freeEnd || freeRuleStart >= freeRuleEnd) {
    context.addIssue({
      code: "custom",
      path: ["campaign", "freeEntryRule"],
      message: "The active free-entry rule must cover the complete free-entry window",
    });
  }

  try {
    const parsed = campaignEligibilityOptions({
      minimumAge: campaign.eligibility.minimumAge,
      eligibleCountriesJson: JSON.stringify(campaign.eligibility.eligibleCountries),
      eligibleRegionsJson: JSON.stringify(campaign.eligibility.eligibleRegions),
      excludedRegionsJson: JSON.stringify(campaign.eligibility.excludedRegions),
    });
    const included = new Set(parsed.includedRegions);
    const duplicatePolicy = parsed.excludedRegions.find((code) => included.has(code));
    if (duplicatePolicy) {
      context.addIssue({
        code: "custom",
        path: ["campaign", "eligibility", "excludedRegions"],
        message: `Region ${duplicatePolicy} cannot be both included and excluded`,
      });
    }
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["campaign", "eligibility"],
      message: error instanceof Error ? error.message : "Eligibility configuration is invalid",
    });
  }

  const slots = campaign.multiplierSchedule;
  for (const [index, slot] of slots.entries()) {
    const slotStart = Date.parse(slot.startsAt);
    const slotEnd = Date.parse(slot.endsAt);
    if (slot.numerator % slot.denominator !== 0) {
      context.addIssue({
        code: "custom",
        path: ["campaign", "multiplierSchedule", index, "denominator"],
        message: "Multiplier period must resolve to an integral factor",
      });
    }
    if (slotStart >= slotEnd) {
      context.addIssue({ code: "custom", path: ["campaign", "multiplierSchedule", index, "endsAt"], message: "Multiplier period must have a positive duration" });
    }
    if (index === 0 && slotStart !== start) {
      context.addIssue({ code: "custom", path: ["campaign", "multiplierSchedule", index, "startsAt"], message: "Multiplier schedule must begin exactly at purchase entry opening" });
    }
    if (index > 0 && slotStart !== Date.parse(slots[index - 1]!.endsAt)) {
      context.addIssue({ code: "custom", path: ["campaign", "multiplierSchedule", index, "startsAt"], message: "Multiplier periods must be ordered, contiguous, and non-overlapping" });
    }
    if (index === slots.length - 1 && slotEnd !== purchaseEnd) {
      context.addIssue({ code: "custom", path: ["campaign", "multiplierSchedule", index, "endsAt"], message: "Multiplier schedule must end exactly at the purchase-entry cutoff" });
    }
  }

  const bandsByPlan = new Map<string, Array<typeof campaign.membershipEntryBands[number]>>();
  for (const band of campaign.membershipEntryBands) {
    const planBands = bandsByPlan.get(band.planProductSlug) ?? [];
    planBands.push(band);
    bandsByPlan.set(band.planProductSlug, planBands);
  }
  for (const [planProductSlug, planBands] of bandsByPlan) {
    const sorted = [...planBands].sort((left, right) => left.minimumSettledCycles - right.minimumSettledCycles);
    for (const [index, band] of sorted.entries()) {
      if (index === 0 && band.minimumSettledCycles !== 0) {
        context.addIssue({
          code: "custom",
          path: ["campaign", "membershipEntryBands"],
          message: `Membership bands for ${planProductSlug} must begin at zero settled cycles`,
        });
      }
      if (band.maximumSettledCycles === null && index !== sorted.length - 1) {
        context.addIssue({
          code: "custom",
          path: ["campaign", "membershipEntryBands"],
          message: `Only the final membership band for ${planProductSlug} may be open-ended`,
        });
      }
      if (index > 0) {
        const previous = sorted[index - 1]!;
        if (previous.maximumSettledCycles === null || band.minimumSettledCycles !== previous.maximumSettledCycles + 1) {
          context.addIssue({
            code: "custom",
            path: ["campaign", "membershipEntryBands"],
            message: `Membership bands for ${planProductSlug} must be ordered, contiguous, and non-overlapping`,
          });
        }
      }
      if (index === sorted.length - 1 && band.maximumSettledCycles !== null) {
        context.addIssue({
          code: "custom",
          path: ["campaign", "membershipEntryBands"],
          message: `The final membership band for ${planProductSlug} must be open-ended`,
        });
      }
    }
  }

  const approvalKinds = campaign.operationalApprovals.map((approval) => approval.kind);
  for (const kind of requiredOperationalApprovalKinds) {
    if (approvalKinds.filter((candidate) => candidate === kind).length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["campaign", "operationalApprovals"],
        message: `Operational approval ${kind} must appear exactly once`,
      });
    }
  }

  if (campaign.filingDetermination.mode === "REQUIREMENTS") {
    const identities = new Set<string>();
    for (const [index, requirement] of campaign.filingDetermination.requirements.entries()) {
      const identity = `${requirement.jurisdiction.toUpperCase()}\u0000${requirement.kind.toUpperCase()}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          path: ["campaign", "filingDetermination", "requirements", index],
          message: "Filing jurisdiction/kind pairs must be unique",
        });
      }
      identities.add(identity);
      if (Date.parse(requirement.completedAt) > start) {
        context.addIssue({
          code: "custom",
          path: ["campaign", "filingDetermination", "requirements", index, "completedAt"],
          message: "Publication evidence must be completed no later than campaign start",
        });
      }
    }
  } else {
    const normalized = campaign.filingDetermination.reviewedJurisdictions.map((item) => item.toUpperCase());
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({
        code: "custom",
        path: ["campaign", "filingDetermination", "reviewedJurisdictions"],
        message: "Reviewed jurisdictions must be unique",
      });
    }
  }
});

export type CampaignOverlay = z.infer<typeof campaignOverlaySchema>;

export function parseCampaignOverlay(value: unknown) {
  return campaignOverlaySchema.parse(value);
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

export function campaignOverlayChecksum(overlay: CampaignOverlay) {
  return createHash("sha256").update(stableJson(overlay)).digest("hex");
}

export function campaignEntryWindow(overlay: CampaignOverlay) {
  const startsAt = new Date(overlay.campaign.windows.startsAt);
  const endsAt = new Date(Math.max(
    Date.parse(overlay.campaign.windows.purchaseEndsAt),
    Date.parse(overlay.campaign.windows.freeEntryEndsAt),
  ));
  return { startsAt, endsAt };
}

export function entryWindowsOverlap(
  left: { startsAt: Date; endsAt: Date },
  right: { startsAt: Date; endsAt: Date },
) {
  return left.startsAt < right.endsAt && right.startsAt < left.endsAt;
}

export function publicationStatus(overlay: CampaignOverlay, now = new Date()) {
  const { startsAt, endsAt } = campaignEntryWindow(overlay);
  if (endsAt <= now) throw new Error("Campaign entry windows have already closed; refusing to publish a dead promotion");
  return startsAt <= now ? "LIVE" as const : "SCHEDULED" as const;
}
