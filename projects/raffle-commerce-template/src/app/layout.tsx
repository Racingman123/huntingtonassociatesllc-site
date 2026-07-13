import type { CSSProperties } from "react";
import type { Metadata } from "next";
import { CartProvider } from "@/components/cart/cart-provider";
import { SiteFooter } from "@/components/storefront/site-footer";
import { SiteHeader } from "@/components/storefront/site-header";
import { getNavigationCampaign, getPublishedTheme, getTenant } from "@/server/storefront";
import { canonicalSiteUrl } from "@/server/site-url";
import { themeCssVariables } from "@/theme/schema";
import { assertCampaignOfficialRules, officialRulesHref } from "@/lib/official-rules";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const [theme, tenant, campaign] = await Promise.all([
    getPublishedTheme(),
    getTenant(),
    getNavigationCampaign(),
  ]);
  const siteUrl = canonicalSiteUrl(tenant);
  const title = campaign
    ? `${theme.brand.displayName} | ${campaign.title}`
    : theme.brand.displayName;
  const description = campaign
    ? `${theme.brand.tagline} ${campaign.shortDescription} No purchase necessary.`
    : theme.brand.tagline;
  return {
    metadataBase: new URL(siteUrl),
    title: { default: title, template: `%s | ${theme.brand.displayName}` },
    description,
    applicationName: theme.brand.displayName,
    keywords: ["giveaway", "sweepstakes", "online store", theme.brand.displayName],
    authors: [{ name: tenant.legalName }],
    creator: tenant.legalName,
    alternates: { canonical: "/" },
    openGraph: {
      type: "website",
      locale: "en_US",
      siteName: theme.brand.displayName,
      title,
      description,
      url: "/",
      images: campaign?.prizes[0]?.image ? [{ url: campaign.prizes[0].image, alt: campaign.prizes[0].name }] : undefined,
    },
    twitter: { card: "summary_large_image", title, description },
    robots: { index: true, follow: true },
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const [theme, tenant, campaign] = await Promise.all([
    getPublishedTheme(),
    getTenant(),
    getNavigationCampaign(),
  ]);
  const themeStyle = themeCssVariables(theme) as CSSProperties;
  const siteUrl = canonicalSiteUrl(tenant);
  const rulesHref = campaign
    ? officialRulesHref(assertCampaignOfficialRules(campaign))
    : null;
  const organizationJsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: tenant.displayName,
    url: siteUrl,
    email: tenant.supportEmail,
  };

  return (
    <html
      lang="en"
      style={themeStyle}
      data-heading-family={theme.typography.headingFamily}
      data-body-family={theme.typography.bodyFamily}
      data-button-style={theme.shape.buttonStyle}
      data-card-style={theme.layout.productCardStyle}
      data-hero-alignment={theme.layout.heroAlignment}
      data-scroll-behavior="smooth"
    >
      <body>
        <CartProvider>
          <SiteHeader
            logoText={theme.brand.logoText}
            logoImage={theme.brand.logoImage}
            logoAlt={theme.brand.logoAlt}
            announcement={theme.layout.announcement}
            campaignSlug={campaign?.slug ?? null}
          />
          <div id="main-content" className="site-main">{children}</div>
          <SiteFooter theme={theme} supportEmail={tenant.supportEmail} campaignSlug={campaign?.slug ?? null} officialRulesHref={rulesHref} />
        </CartProvider>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd).replaceAll("<", "\\u003c") }}
        />
      </body>
    </html>
  );
}
