import { z } from "zod";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color");
const publicWebUrl = z.union([
  z.literal(""),
  z.url().refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "https:" || protocol === "http:";
    } catch {
      return false;
    }
  }, "Use an HTTP or HTTPS URL"),
]);
const publicAssetPath = z.union([
  z.literal(""),
  z.string().trim().max(500).refine((value) => (
    value.startsWith("/")
    && !value.startsWith("//")
    && !value.split("/").includes("..")
  ), "Use a root-relative public asset path"),
]);

export const themeConfigSchema = z.object({
  schemaVersion: z.literal(1),
  brand: z.object({
    displayName: z.string().min(1).max(80),
    shortName: z.string().min(1).max(20),
    tagline: z.string().min(1).max(160),
    logoText: z.string().min(1).max(24),
    logoImage: publicAssetPath.optional(),
    logoAlt: z.string().trim().max(120).optional(),
  }),
  colors: z.object({
    background: hexColor,
    foreground: hexColor,
    surface: hexColor,
    surfaceStrong: hexColor,
    muted: hexColor,
    primary: hexColor,
    primaryForeground: hexColor,
    accent: hexColor,
    accentForeground: hexColor,
    border: hexColor,
    success: hexColor,
    warning: hexColor,
    danger: hexColor,
  }),
  typography: z.object({
    headingFamily: z.enum(["sans", "condensed", "serif"]),
    bodyFamily: z.enum(["sans", "serif"]),
    headingWeight: z.number().int().min(600).max(900),
    letterSpacing: z.number().min(-0.08).max(0.12),
  }),
  shape: z.object({
    radiusSmall: z.number().int().min(0).max(24),
    radiusMedium: z.number().int().min(0).max(40),
    radiusLarge: z.number().int().min(0).max(80),
    buttonStyle: z.enum(["square", "rounded", "pill"]),
  }),
  layout: z.object({
    maxWidth: z.number().int().min(960).max(1920),
    announcement: z.string().min(1).max(140),
    heroAlignment: z.enum(["left", "center"]),
    productCardStyle: z.enum(["editorial", "compact", "bordered"]),
  }),
  social: z.object({
    instagram: publicWebUrl,
    youtube: publicWebUrl,
    tiktok: publicWebUrl,
  }),
});

export type ThemeConfig = z.infer<typeof themeConfigSchema>;

export function parseThemeConfig(value: unknown): ThemeConfig {
  return themeConfigSchema.parse(value);
}

export function themeCssVariables(theme: ThemeConfig): Record<string, string> {
  return {
    "--color-background": theme.colors.background,
    "--color-foreground": theme.colors.foreground,
    "--color-surface": theme.colors.surface,
    "--color-surface-strong": theme.colors.surfaceStrong,
    "--color-muted": theme.colors.muted,
    "--color-primary": theme.colors.primary,
    "--color-primary-foreground": theme.colors.primaryForeground,
    "--color-accent": theme.colors.accent,
    "--color-accent-foreground": theme.colors.accentForeground,
    "--color-border": theme.colors.border,
    "--color-success": theme.colors.success,
    "--color-warning": theme.colors.warning,
    "--color-danger": theme.colors.danger,
    "--radius-sm": `${theme.shape.radiusSmall}px`,
    "--radius-md": `${theme.shape.radiusMedium}px`,
    "--radius-lg": `${theme.shape.radiusLarge}px`,
    "--site-max-width": `${theme.layout.maxWidth}px`,
    "--heading-weight": String(theme.typography.headingWeight),
    "--heading-tracking": `${theme.typography.letterSpacing}em`,
  };
}
