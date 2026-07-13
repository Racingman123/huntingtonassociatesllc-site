import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, FileCheck2, LockKeyhole, RotateCcw, ScrollText } from "lucide-react";
import { Container } from "@/components/ui/container";
import { PageHero } from "@/components/storefront/page-hero";

export const metadata: Metadata = {
  title: "Policies",
  description: "Review the Official Rules, privacy notice, website terms, and shipping and returns policy.",
  alternates: { canonical: "/policies" },
};

const policyCards = [
  { href: "/policies/official-rules", title: "Official Rules", text: "Eligibility, dates, entry methods, entry caps, prize terms, odds, drawing, and winner verification.", icon: FileCheck2 },
  { href: "/policies/privacy", title: "Privacy Notice", text: "What information is collected, why it is used, retention, choices, and contact information.", icon: LockKeyhole },
  { href: "/policies/terms", title: "Website Terms", text: "Rules for using the storefront, accounts, purchases, content, and site services.", icon: ScrollText },
  { href: "/policies/shipping-returns", title: "Shipping & Returns", text: "Fulfillment expectations, exchanges, refunds, and how order adjustments affect entries.", icon: RotateCcw },
] as const;

export default function PoliciesPage() {
  return (
    <main className="public-page">
      <PageHero eyebrow="Legal center" title="Rules you can actually find." description="Promotion rules and store policies should not be buried. Start with the document that matches your question." tone="light" />
      <section className="section"><Container><div className="policy-card-grid">{policyCards.map(({ href, title, text, icon: Icon }) => <Link key={href} href={href}><Icon aria-hidden="true" /><h2>{title}</h2><p>{text}</p><span>Read document <ArrowRight aria-hidden="true" size={18} /></span></Link>)}</div></Container></section>
      <section className="policy-warning"><Container><strong>Template notice</strong><p>These are demonstration documents, not legal advice. A real sponsor must replace them with promotion- and jurisdiction-specific documents reviewed by qualified counsel before accepting entries or orders.</p></Container></section>
    </main>
  );
}
