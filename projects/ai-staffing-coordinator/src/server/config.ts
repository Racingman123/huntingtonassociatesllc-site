import "dotenv/config";
import { z } from "zod";

const booleanFromEnv = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default("0.0.0.0"),
    DATABASE_URL: z.string().min(1).default("postgresql://staffing:staffing@localhost:5432/staffing"),
    DATABASE_SSL: booleanFromEnv,
    JWT_SECRET: z.string().min(16).default("development-only-change-me"),
    PUBLIC_DEMO_MODE: booleanFromEnv,
    PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
    COMPANY_DISPLAY_NAME: z.string().min(1).default("Acme Staffing"),
    DEFAULT_TIMEZONE: z.string().min(1).default("America/New_York"),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().default("gpt-5.6-luna"),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_PHONE_NUMBER: z.string().optional(),
    TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
    TWILIO_VALIDATE_WEBHOOKS: booleanFromEnv,
    COMMUNICATION_PROVIDER: z.enum(["twilio", "mock"]).default("mock"),
    AGENT_DISCLOSURE: z
      .string()
      .default("This is an automated scheduling assistant calling on behalf of your staffing company."),
    SCHEDULER_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
    SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
    REMINDER_OFFSETS_MINUTES: z.string().default("1440,120"),
    CONTACT_WINDOW_START_LOCAL: z.coerce.number().int().min(0).max(23).default(8),
    CONTACT_WINDOW_END_LOCAL: z.coerce.number().int().min(1).max(24).default(20),
    MAX_CALL_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
    MAX_CONCURRENT_OUTBOUND_CALLS: z.coerce.number().int().min(1).max(100).default(5),
    TRANSCRIPT_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
    ADMIN_EMAIL: z.string().email().default("admin@example.com"),
    ADMIN_PASSWORD: z.string().min(10).default("ChangeMe123!"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  })
  .superRefine((value, ctx) => {
    if (value.PUBLIC_DEMO_MODE && value.COMMUNICATION_PROVIDER !== "mock") {
      ctx.addIssue({
        code: "custom",
        path: ["COMMUNICATION_PROVIDER"],
        message: "PUBLIC_DEMO_MODE requires COMMUNICATION_PROVIDER=mock",
      });
    }
    if (value.NODE_ENV === "production" && value.JWT_SECRET === "development-only-change-me") {
      ctx.addIssue({ code: "custom", path: ["JWT_SECRET"], message: "JWT_SECRET must be changed in production" });
    }
    if (value.NODE_ENV === "production" && value.JWT_SECRET.length < 32) {
      ctx.addIssue({ code: "custom", path: ["JWT_SECRET"], message: "JWT_SECRET must contain at least 32 characters in production" });
    }
    if (value.NODE_ENV === "production" && value.ADMIN_PASSWORD === "ChangeMe123!") {
      ctx.addIssue({ code: "custom", path: ["ADMIN_PASSWORD"], message: "ADMIN_PASSWORD must be changed in production" });
    }
    if (value.NODE_ENV === "production" && !value.PUBLIC_BASE_URL.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["PUBLIC_BASE_URL"], message: "PUBLIC_BASE_URL must use HTTPS" });
    }
    if (value.COMMUNICATION_PROVIDER === "twilio") {
      for (const key of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"] as const) {
        if (!value[key]) ctx.addIssue({ code: "custom", path: [key], message: `${key} is required for Twilio` });
      }
      if (value.NODE_ENV === "production" && !value.OPENAI_API_KEY) {
        ctx.addIssue({ code: "custom", path: ["OPENAI_API_KEY"], message: "OPENAI_API_KEY is required for live voice automation" });
      }
      if (value.NODE_ENV === "production" && !value.TWILIO_VALIDATE_WEBHOOKS) {
        ctx.addIssue({
          code: "custom",
          path: ["TWILIO_VALIDATE_WEBHOOKS"],
          message: "Twilio webhook validation must be enabled in production",
        });
      }
    }
  });

export type AppConfig = z.infer<typeof schema> & { reminderOffsetsMinutes: number[] };

export function loadConfig(overrides: Record<string, unknown> = {}): AppConfig {
  const parsed = schema.parse({ ...process.env, ...overrides });
  const reminderOffsetsMinutes = parsed.REMINDER_OFFSETS_MINUTES.split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((a, b) => b - a);
  return { ...parsed, reminderOffsetsMinutes };
}

export const config = loadConfig();
