import { createHash } from "node:crypto";
import { z } from "zod";
import { isTwoDecimalCurrency } from "@/lib/format";
import { fitsBcryptInput } from "@/lib/password-policy";

const slugSchema = z.string().trim().min(1).max(100).regex(
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  "Use lowercase words separated by hyphens",
);

const emailSchema = z.string().trim().toLowerCase().max(254).email();

const domainSchema = z.string().trim().toLowerCase().max(253).regex(
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  "Use a hostname only, without a protocol, port, path, or wildcard",
);

const timezoneSchema = z.string().trim().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}, "Use a supported IANA time zone such as America/New_York");

const staffSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: emailSchema,
  mailboxVerification: z.object({
    verifiedAt: z.string().datetime({ offset: true }),
    evidenceRef: z.string().trim().min(8).max(500).refine(
      (value) => !/(?:placeholder|replace[\s_-]*me|todo)/i.test(value),
      "Use a real reviewed mailbox-verification evidence reference",
    ),
  }).strict(),
}).strict();

export const tenantBootstrapSchema = z.object({
  schemaVersion: z.literal(1),
  tenant: z.object({
    slug: slugSchema,
    displayName: z.string().trim().min(2).max(160),
    legalName: z.string().trim().min(2).max(200),
    supportEmail: emailSchema,
    primaryDomain: domainSchema,
    currency: z.string().trim().regex(/^[A-Z]{3}$/, "Use an uppercase ISO 4217 currency code")
      .refine(isTwoDecimalCurrency, "Use a supported currency with exactly two minor-unit digits"),
    timezone: timezoneSchema,
  }).strict(),
  initialStaff: z.object({
    administrator: staffSchema,
    compliance: staffSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.initialStaff.administrator.email === value.initialStaff.compliance.email) {
    context.addIssue({
      code: "custom",
      path: ["initialStaff", "compliance", "email"],
      message: "Administrator and compliance must use distinct email addresses",
    });
  }
  if (
    value.initialStaff.administrator.mailboxVerification.evidenceRef
    === value.initialStaff.compliance.mailboxVerification.evidenceRef
  ) {
    context.addIssue({
      code: "custom",
      path: ["initialStaff", "compliance", "mailboxVerification", "evidenceRef"],
      message: "Administrator and compliance mailbox proofs must be distinct",
    });
  }
});

export const bootstrapPasswordSchema = z.string()
  .min(14, "Use at least 14 characters")
  .max(128, "Use no more than 128 characters")
  .refine(fitsBcryptInput, "Use no more than 72 UTF-8 bytes because bcrypt truncates longer inputs")
  .regex(/[a-z]/, "Include a lowercase letter")
  .regex(/[A-Z]/, "Include an uppercase letter")
  .regex(/[0-9]/, "Include a number")
  .regex(/[^A-Za-z0-9]/, "Include a symbol")
  .refine(
    (value) => !/(?:password|passw0rd|change[\s_-]*me|placeholder|replace[\s_-]*me|example|default|qwerty|letmein|welcome|bootstrap)/i.test(value),
    "Do not use a placeholder or common password phrase",
  );

export const BOOTSTRAP_BCRYPT_COST = 12;

export type TenantBootstrap = z.infer<typeof tenantBootstrapSchema>;

export function parseTenantBootstrap(value: unknown) {
  return tenantBootstrapSchema.parse(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

/** This digest covers only the reviewed, non-secret bootstrap manifest. */
export function tenantBootstrapChecksum(config: TenantBootstrap) {
  return createHash("sha256").update(stableJson(config)).digest("hex");
}
