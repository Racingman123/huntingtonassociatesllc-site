import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, FileCheck2 } from "lucide-react";
import { Container } from "@/components/ui/container";
import { LegalBody } from "@/components/storefront/legal-body";
import { formatDateTime } from "@/lib/format";
import { getLegalDocument, getTenant } from "@/server/storefront";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const [document, tenant] = await Promise.all([getLegalDocument(slug), getTenant()]);
  return { title: document.title, description: `Read the current ${document.title} for ${tenant.displayName}.`, alternates: { canonical: `/policies/${document.slug}` } };
}

export default async function PolicyDocumentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const document = await getLegalDocument(slug);
  return (
    <main className="public-page">
      <header className="legal-header">
        <Container><Link className="back-link" href="/policies"><ArrowLeft aria-hidden="true" size={16} /> All policies</Link><p className="eyebrow"><FileCheck2 aria-hidden="true" /> Published document</p><h1>{document.title}</h1><div><span>Version {document.version}</span><span>Effective {document.effectiveAt ? formatDateTime(document.effectiveAt) : "Not specified"}</span><span>Checksum {document.checksum.slice(0, 12)}…</span></div></Container>
      </header>
      <section className="legal-document section"><Container><LegalBody body={document.body} /><aside><strong>Important</strong><p>This example is not legal advice. Replace it with counsel-approved language for the sponsor, prize, jurisdictions, and operating model before launch.</p><Link href={`/policies/${document.slug}/history`}>View document history</Link><Link href="/help">Questions about the site?</Link></aside></Container></section>
    </main>
  );
}
