import type { StoreProduct } from "./product-card";
import { ProductCard } from "./product-card";
import type { StorefrontEntryQuoteLookup } from "@/server/commerce/storefront-quotes";

export function ProductGrid({
  products,
  entryQuotes,
  showQuickAdd = true,
  entriesAvailable,
  currency,
}: {
  products: StoreProduct[];
  entryQuotes: StorefrontEntryQuoteLookup;
  showQuickAdd?: boolean;
  entriesAvailable: boolean;
  currency: string;
}) {
  return (
    <div className="product-grid">
      {products.map((product) => (
        <ProductCard
          key={product.id}
          product={product}
          entryQuotes={entryQuotes}
          showQuickAdd={showQuickAdd}
          entriesAvailable={entriesAvailable}
          currency={currency}
        />
      ))}
    </div>
  );
}
