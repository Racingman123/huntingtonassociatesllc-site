import type { ThemeConfig } from "./schema";

function channel(value: number) {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string) {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

export function contrastRatio(foreground: string, background: string) {
  const a = luminance(foreground);
  const b = luminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

export type ContrastIssue = {
  pair: string;
  foreground: string;
  background: string;
  ratio: number;
  minimum: number;
};

/** Required text pairs used by the shared components. */
export function themeContrastIssues(theme: ThemeConfig): ContrastIssue[] {
  const pairs = [
    ["foreground/background", theme.colors.foreground, theme.colors.background, 4.5],
    ["foreground/surface", theme.colors.foreground, theme.colors.surface, 4.5],
    ["muted/background", theme.colors.muted, theme.colors.background, 4.5],
    ["muted/surface", theme.colors.muted, theme.colors.surface, 4.5],
    ["primary button", theme.colors.primaryForeground, theme.colors.primary, 4.5],
    ["accent button", theme.colors.accentForeground, theme.colors.accent, 4.5],
    ["success/surface", theme.colors.success, theme.colors.surface, 4.5],
    ["warning/surface", theme.colors.warning, theme.colors.surface, 4.5],
    ["danger/surface", theme.colors.danger, theme.colors.surface, 4.5],
    ["danger/background", theme.colors.danger, theme.colors.background, 4.5],
    ["danger/surface strong", theme.colors.danger, theme.colors.surfaceStrong, 4.5],
    ["danger fill", theme.colors.primaryForeground, theme.colors.danger, 4.5],
    ["warning fill", theme.colors.primaryForeground, theme.colors.warning, 4.5],
  ] as const;

  return pairs.flatMap(([pair, foreground, background, minimum]) => {
    const ratio = contrastRatio(foreground, background);
    return ratio + Number.EPSILON < minimum
      ? [{ pair, foreground, background, ratio, minimum }]
      : [];
  });
}
