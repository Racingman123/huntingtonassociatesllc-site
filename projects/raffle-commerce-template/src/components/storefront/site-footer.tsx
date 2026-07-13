import Link from "next/link";
import type { ThemeConfig } from "@/theme/schema";
import { Container } from "@/components/ui/container";
import { NewsletterForm } from "@/components/forms/newsletter-form";
import { Logo } from "./logo";
import type { OfficialRulesHref } from "@/lib/official-rules";

export function SiteFooter({
  theme,
  supportEmail,
  campaignSlug,
  officialRulesHref,
}: {
  theme: ThemeConfig;
  supportEmail: string;
  campaignSlug: string | null;
  officialRulesHref: OfficialRulesHref | null;
}) {
  return (
    <footer className="site-footer">
      <Container>
        <div className="footer-lead">
          <div>
            <p className="eyebrow">Stay trail-ready</p>
            <h2>New gear. New builds. One fair shot.</h2>
          </div>
          <NewsletterForm />
        </div>

        <div className="footer-grid">
          <div className="footer-brand">
            <Logo label={theme.brand.logoText} image={theme.brand.logoImage} imageAlt={theme.brand.logoAlt} />
            <p>{theme.brand.tagline}</p>
            <div className="footer-socials" aria-label="Social links">
              {theme.social.instagram ? <a href={theme.social.instagram} target="_blank" rel="noreferrer" aria-label="Instagram">IG</a> : null}
              {theme.social.youtube ? <a href={theme.social.youtube} target="_blank" rel="noreferrer" aria-label="YouTube">YT</a> : null}
              {theme.social.tiktok ? <a href={theme.social.tiktok} target="_blank" rel="noreferrer" aria-label="TikTok">TT</a> : null}
            </div>
          </div>
          <nav aria-label="Shop links">
            <h3>Shop</h3>
            <Link href="/shop">All products</Link>
            <Link href="/collections/new-releases">New releases</Link>
            <Link href="/quick-entry">Quick entry</Link>
            <Link href="/collections/gear">Gear</Link>
            <Link href="/collections/apparel">Apparel</Link>
          </nav>
          <nav aria-label="Giveaway links">
            <h3>Giveaways</h3>
            {campaignSlug ? <Link href={`/giveaways/${campaignSlug}`}>Current giveaway</Link> : <Link href="/giveaways">Giveaways</Link>}
            {campaignSlug ? <Link href={`/giveaways/${campaignSlug}/free-entry`}>Free entry</Link> : null}
            <Link href="/how-it-works">How it works</Link>
            <Link href="/winners">Past winners</Link>
            <Link href="/scam-awareness">Scam awareness</Link>
          </nav>
          <nav aria-label="Company links">
            <h3>Company</h3>
            <Link href="/about">About us</Link>
            <Link href="/membership">Membership</Link>
            <Link href="/help">Help center</Link>
            <a href={`mailto:${supportEmail}`}>Contact support</a>
            <Link href="/policies">Policies</Link>
          </nav>
        </div>

        <div className="footer-legal">
          <p><strong>NO PURCHASE NECESSARY TO ENTER OR WIN.</strong> A purchase will not increase your chances of winning. Void where prohibited. See Official Rules for eligibility, entry periods, prize details, odds, and the free alternative method of entry.</p>
          <div>
            <span>© {new Date().getFullYear()} {theme.brand.displayName}</span>
            {officialRulesHref ? <Link href={officialRulesHref}>Official Rules</Link> : <Link href="/policies">Policies</Link>}
            <Link href="/policies/privacy">Privacy</Link>
            <Link href="/policies/terms">Terms</Link>
            {campaignSlug ? <Link href={`/giveaways/${campaignSlug}`}>Current giveaway</Link> : null}
          </div>
        </div>
      </Container>
    </footer>
  );
}
