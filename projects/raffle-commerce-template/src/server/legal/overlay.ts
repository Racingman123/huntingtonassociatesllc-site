import { createHash } from "node:crypto";
import { z } from "zod";

const slug = z.string().trim().min(1).max(100).regex(
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  "Use lowercase words separated by hyphens",
);
const timestamp = z.string().trim().refine((value) => (
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value))
), "Use an RFC 3339 timestamp with an explicit UTC offset");

export const legalDocumentKinds = [
  "OFFICIAL_RULES",
  "PRIVACY",
  "TERMS",
  "RETURNS",
  "SUBSCRIPTION_TERMS",
  "ACCESSIBILITY",
  "WINNER_LIST",
] as const;

const legalDocumentSchema = z.object({
  kind: z.enum(legalDocumentKinds),
  slug,
  title: z.string().trim().min(1).max(180),
  version: z.number().int().positive().max(1_000_000),
  effectiveAt: timestamp,
  body: z.string().trim().min(100).max(1_000_000),
}).strict().superRefine((document, context) => {
  if (document.kind === "OFFICIAL_RULES") {
    if (!/NO\s+PURCHASE\s+NECESSARY/i.test(document.body)) {
      context.addIssue({ code: "custom", path: ["body"], message: "Official Rules must state NO PURCHASE NECESSARY" });
    }
    if (!/PURCHASE[\s\S]{0,120}(?:WILL\s+NOT|DOES\s+NOT)[\s\S]{0,120}INCREASE[\s\S]{0,80}CHANCE/i.test(document.body)) {
      context.addIssue({ code: "custom", path: ["body"], message: "Official Rules must state that purchase does not increase the chance of winning" });
    }
  }
});

export const legalReleaseSchema = z.object({
  schemaVersion: z.literal(1),
  targetTenantSlug: slug,
  releaseName: z.string().trim().min(1).max(160),
  documents: z.array(legalDocumentSchema).min(1).max(50),
}).strict().superRefine((release, context) => {
  const kinds = new Set<string>();
  const slugs = new Set<string>();
  release.documents.forEach((document, index) => {
    if (kinds.has(document.kind)) {
      context.addIssue({ code: "custom", path: ["documents", index], message: `Release contains more than one ${document.kind} document` });
    }
    if (slugs.has(document.slug)) {
      context.addIssue({ code: "custom", path: ["documents", index], message: `Release contains duplicate slug ${document.slug}` });
    }
    kinds.add(document.kind);
    slugs.add(document.slug);
  });
});

export type LegalRelease = z.infer<typeof legalReleaseSchema>;

export function parseLegalRelease(value: unknown) {
  return legalReleaseSchema.parse(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

export function legalBodyChecksum(body: string) {
  return createHash("sha256").update(body).digest("hex");
}

export function legalReleaseChecksum(release: LegalRelease) {
  return createHash("sha256").update(stableJson(release)).digest("hex");
}
