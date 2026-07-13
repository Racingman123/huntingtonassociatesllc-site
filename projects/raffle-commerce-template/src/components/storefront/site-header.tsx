import Link from "next/link";
import { Menu, Search, UserRound } from "lucide-react";
import { CartCountLink } from "@/components/cart/cart-count-link";
import { Logo } from "./logo";

const primaryLinks = [
  { href: "/shop", label: "Shop" },
  { href: "/quick-entry", label: "Quick entry" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/winners", label: "Winners" },
  { href: "/membership", label: "Members" },
] as const;

export function SiteHeader({
  logoText,
  logoImage,
  logoAlt,
  announcement,
  campaignSlug,
}: {
  logoText: string;
  logoImage?: string;
  logoAlt?: string;
  announcement: string;
  campaignSlug: string | null;
}) {
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <div className="announcement-bar">
        <p>{announcement}</p>
        {campaignSlug ? <Link href={`/giveaways/${campaignSlug}`}>See the prize</Link> : null}
      </div>
      <header className="site-header">
        <div className="site-header-inner site-container">
          <details className="mobile-nav">
            <summary aria-label="Open navigation"><Menu aria-hidden="true" size={24} /></summary>
            <nav aria-label="Mobile navigation">
              {campaignSlug ? <Link className="mobile-featured-link" href={`/giveaways/${campaignSlug}`}>Current giveaway</Link> : null}
              {primaryLinks.map((link) => <Link key={link.href} href={link.href}>{link.label}</Link>)}
              <Link href="/about">Our story</Link>
              <Link href="/help">Help center</Link>
              {campaignSlug ? <Link href={`/giveaways/${campaignSlug}/free-entry`}>Enter without purchase</Link> : null}
            </nav>
          </details>

          <Logo label={logoText} image={logoImage} imageAlt={logoAlt} />

          <nav className="desktop-nav" aria-label="Primary navigation">
            {campaignSlug ? <Link className="nav-giveaway" href={`/giveaways/${campaignSlug}`}>Current giveaway</Link> : null}
            {primaryLinks.map((link) => <Link key={link.href} href={link.href}>{link.label}</Link>)}
          </nav>

          <div className="header-actions">
            <Link className="search-link" href="/search" aria-label="Search products">
              <Search aria-hidden="true" size={20} strokeWidth={1.8} />
            </Link>
            <Link className="account-link" href="/account" aria-label="Your account">
              <UserRound aria-hidden="true" size={21} strokeWidth={1.8} />
              <span>Account</span>
            </Link>
            <CartCountLink />
          </div>
        </div>
      </header>
    </>
  );
}
