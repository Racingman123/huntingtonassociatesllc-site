import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, FileClock } from "lucide-react";
import { Container } from "@/components/ui/container";
import { LegalBody } from "@/components/storefront/legal-body";
import { formatDateTime } from "@/lib/format";
import { getLegalDocumentVersion } from "@/server/storefront";

type Props = { params: Promise<{ slug: string; version: string }> };

async function documentFromParams(params: Props["params"]) {
  const { slug, version } = await params;
  return getLegalDocumentVersion(slug, Number(version));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const document = await documentFromParams(params);
  return {
    title: `${document.title} v${document.version}`,
    description: `Archived published version ${document.version} of ${document.title}.`,
    alternates: { canonical: `/policies/${document.slug}/versions/${document.version}` },
  };
}

export default async function LegalVersionPage({ params }: Props) {
  const document = await documentFromParams(params);
  return (
    <main className="public-page">
      <header className="legal-header">
        <Container>
          <Link className="back-link" href={`/policies/${document.slug}/history`}><ArrowLeft aria-hidden="true" size={16} /> Version history</Link>
          <p className="eyebrow"><FileClock aria-hidden="true" /> Historical published document</p>
          <h1>{document.title}</h1>
          <div><span>Version {document.version}</span><span>Effective {document.effectiveAt ? formatDateTime(document.effectiveAt) : "Not specified"}</span><span>Checksum {document.checksum.slice(0, 12)}…</span></div>
        </Container>
      </header>
      <section className="legal-document section">
        <Container>
          <LegalBody body={document.body} />
          <aside><strong>Historical version</strong><p>This text is preserved for auditability and may not be the current policy.</p><Link href={`/policies/${document.slug}`}>Read the current version</Link></aside>
        </Container>
      </section>
    </main>
  );
}
