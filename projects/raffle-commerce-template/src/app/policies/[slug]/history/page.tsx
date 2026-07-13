import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, History } from "lucide-react";
import { Container } from "@/components/ui/container";
import { formatDateTime } from "@/lib/format";
import { getLegalDocumentHistory } from "@/server/storefront";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const documents = await getLegalDocumentHistory(slug);
  return {
    title: `${documents[0].title} history`,
    description: `Published version history for ${documents[0].title}.`,
    alternates: { canonical: `/policies/${slug}/history` },
  };
}

export default async function LegalHistoryPage({ params }: Props) {
  const { slug } = await params;
  const documents = await getLegalDocumentHistory(slug);
  const latest = documents[0];
  return (
    <main className="public-page">
      <header className="legal-header">
        <Container>
          <Link className="back-link" href={`/policies/${slug}`}><ArrowLeft aria-hidden="true" size={16} /> Current document</Link>
          <p className="eyebrow"><History aria-hidden="true" /> Publication record</p>
          <h1>{latest.title} history</h1>
          <div><span>{documents.length} published version{documents.length === 1 ? "" : "s"}</span><span>Latest v{latest.version}</span></div>
        </Container>
      </header>
      <section className="section legal-history">
        <Container>
          <p>Each row identifies the exact published text by version and SHA-256 checksum. Historical records remain available so entrants can review the terms that applied when they entered.</p>
          <ol>
            {documents.map((document, index) => (
              <li key={document.id}>
                <div><strong>Version {document.version}</strong>{index === 0 ? <span>Current</span> : null}</div>
                <p>Effective {document.effectiveAt ? formatDateTime(document.effectiveAt) : "Not specified"}</p>
                <code>{document.checksum}</code>
                <Link href={`/policies/${slug}/versions/${document.version}`}>Read this version</Link>
              </li>
            ))}
          </ol>
        </Container>
      </section>
    </main>
  );
}
