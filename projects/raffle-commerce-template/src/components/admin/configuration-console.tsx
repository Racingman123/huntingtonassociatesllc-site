import { formatDateTime, formatMoney, titleCase } from "@/lib/format";
import type { getAdminConfiguration } from "@/server/admin/dal";
import { AdminBadge } from "./admin-badge";
import { AdminPageHeader } from "./admin-page-header";
import styles from "./admin.module.css";

type ConfigurationData = Awaited<ReturnType<typeof getAdminConfiguration>>;

function fingerprint(value: string) {
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-8)}` : value;
}

export function ConfigurationConsole({ data }: { data: ConfigurationData }) {
  const timezone = data.identity.tenant.timezone;
  return (
    <>
      <AdminPageHeader
        eyebrow="Template readiness"
        title="Theme & catalog"
        description="Published theme integrity, merchandise inventory, collections, legal documents, and production adapter configuration."
        meta={<>Tenant: {data.identity.tenant.displayName}<br />Read-only configuration inventory</>}
      />
      <section className={styles.metrics} aria-label="Configuration metrics">
        <Metric label="Theme versions" value={String(data.themes.length)} meta={`${data.themes.filter((item) => item.status === "PUBLISHED").length} published`} />
        <Metric label="Products" value={String(data.catalog.productCount)} meta={`${data.catalog.activeCount} active`} />
        <Metric label="Low stock" value={String(data.catalog.lowStockCount)} meta="Physical inventory ≤ 20" />
        <Metric label="Collections" value={String(data.catalog.collectionCount)} meta="Catalog groupings" />
        <Metric label="Legal versions" value={String(data.legalDocuments.length)} meta={`${data.legalDocuments.filter((item) => item.status === "PUBLISHED").length} published`} />
        <Metric label="Integrations" value={data.integrations.ready ? "Ready" : data.integrations.demoMode ? "Demo" : "Review"} meta="Required adapter posture" />
      </section>

      <div className={styles.gridTwo}>
        <div className={styles.stack}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}><div><h2>Theme versions</h2><p>Stored JSON is re-hashed and compared with its published fingerprint.</p></div></div>
            {data.themes.length ? (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead><tr><th>Version</th><th>Name</th><th>Status</th><th>Integrity</th><th>Fingerprint</th><th>Published</th></tr></thead>
                  <tbody>{data.themes.map((theme) => (
                    <tr key={theme.id}>
                      <td className={styles.numeric}>v{theme.version}</td>
                      <td><strong>{theme.name}</strong></td>
                      <td><AdminBadge value={theme.status} /></td>
                      <td className={theme.checksumValid ? styles.integrityGood : styles.integrityBad}>{theme.checksumValid ? "Verified" : "Mismatch"}</td>
                      <td className={styles.numeric}>{fingerprint(theme.checksum)}</td>
                      <td className={styles.numeric}>{theme.publishedAt ? formatDateTime(theme.publishedAt, timezone) : "—"}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <div className={styles.empty}><strong>No themes</strong>A published theme is required for storefront launch.</div>}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}><div><h2>Catalog readiness</h2><p>Product multiplier and inventory values are operational, not presentation-only fields.</p></div></div>
            {data.products.length ? (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead><tr><th>Product</th><th>Type</th><th>Category</th><th>Status</th><th>Price</th><th>Inventory</th><th>Entry rate</th><th>Usage</th></tr></thead>
                  <tbody>{data.products.map((product) => (
                    <tr key={product.id}>
                      <td><div className={styles.primaryCell}><strong>{product.title}</strong><span>{product.slug}{product.featured ? " · featured" : ""}</span></div></td>
                      <td>{titleCase(product.productType)}</td>
                      <td>{product.category}</td>
                      <td><AdminBadge value={product.status} /></td>
                      <td className={styles.numeric}>{formatMoney(product.priceCents, data.identity.tenant.currency)}</td>
                      <td className={`${styles.numeric} ${product.productType === "PHYSICAL" && product.inventory <= 20 ? styles.negative : ""}`}>{product.inventory}</td>
                      <td className={styles.numeric}>{product.entryMultiplier}× product</td>
                      <td><div className={styles.primaryCell}><strong>{product._count.variants} variant(s)</strong><span>{product._count.orderLines} order line(s)</span></div></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <div className={styles.empty}><strong>No products</strong>Add a catalog before enabling checkout.</div>}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}><h2>Published legal inventory</h2></div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>Document</th><th>Kind</th><th>Version</th><th>Status</th><th>Effective</th><th>Fingerprint</th></tr></thead>
                <tbody>{data.legalDocuments.map((document) => (
                  <tr key={document.id}>
                    <td><div className={styles.primaryCell}><strong>{document.title}</strong><span>/policies/{document.slug}</span></div></td>
                    <td>{titleCase(document.kind)}</td>
                    <td className={styles.numeric}>v{document.version}</td>
                    <td><AdminBadge value={document.status} /></td>
                    <td className={styles.numeric}>{document.effectiveAt ? formatDateTime(document.effectiveAt, timezone) : "—"}</td>
                    <td className={styles.numeric}>{fingerprint(document.checksum)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        </div>

        <aside className={styles.stack}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}><h2>Integration adapters</h2><AdminBadge value={data.integrations.ready ? "READY" : data.integrations.demoMode ? "DEMO" : "ACTION_REQUIRED"} /></div>
            <ul className={styles.readinessList}>{data.integrations.checks.map((check) => (
              <li className={styles.readinessItem} key={check.key}><div><strong>{check.label}</strong><p>{check.detail}</p></div><AdminBadge value={check.status} /></li>
            ))}</ul>
          </section>
          <section className={styles.panel}>
            <div className={styles.panelHeader}><h2>Collections</h2></div>
            <ul className={styles.readinessList}>{data.collections.map((collection) => (
              <li className={styles.readinessItem} key={collection.id}><div><strong>{collection.title}</strong><p>{collection.slug} · sort {collection.sortOrder}</p></div><span className={styles.numeric}>{collection._count.products} products</span></li>
            ))}</ul>
          </section>
        </aside>
      </div>
    </>
  );
}

function Metric({ label, value, meta }: { label: string; value: string; meta: string }) {
  return <div className={styles.metric}><span className={styles.metricLabel}>{label}</span><strong className={styles.metricValue}>{value}</strong><span className={styles.metricMeta}>{meta}</span></div>;
}

