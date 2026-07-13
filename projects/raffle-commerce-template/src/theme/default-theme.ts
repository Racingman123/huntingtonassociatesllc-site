import type { ThemeConfig } from "./schema";

export const defaultTheme: ThemeConfig = {
  schemaVersion: 1,
  brand: {
    displayName: "Northstar Supply Co.",
    shortName: "NORTHSTAR",
    tagline: "Gear up. Get outside. Win something unforgettable.",
    logoText: "NORTHSTAR",
    logoImage: "",
    logoAlt: "Northstar Supply Co.",
  },
  colors: {
    background: "#f5f3ed",
    foreground: "#141713",
    surface: "#ffffff",
    surfaceStrong: "#e6e2d8",
    muted: "#666b63",
    primary: "#dc351d",
    primaryForeground: "#ffffff",
    accent: "#d9ff43",
    accentForeground: "#141713",
    border: "#cbc8be",
    success: "#247a48",
    warning: "#ad5d10",
    danger: "#b92d2d",
  },
  typography: {
    headingFamily: "condensed",
    bodyFamily: "sans",
    headingWeight: 900,
    letterSpacing: -0.035,
  },
  shape: {
    radiusSmall: 3,
    radiusMedium: 8,
    radiusLarge: 20,
    buttonStyle: "square",
  },
  layout: {
    maxWidth: 1480,
    announcement: "250X ENTRIES THIS WEEK — NO PURCHASE NECESSARY",
    heroAlignment: "left",
    productCardStyle: "editorial",
  },
  social: {
    instagram: "https://instagram.com/",
    youtube: "https://youtube.com/",
    tiktok: "https://tiktok.com/",
  },
};
