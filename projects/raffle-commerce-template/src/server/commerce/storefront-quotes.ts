import "server-only";
import type { Campaign, EntryRule, Product, ProductCollection, ProductVariant, Collection } from "@prisma/client";
import { createStorefrontEntryQuote, type StorefrontEntryQuote } from "@/lib/purchase-entry-rules";

export type QuoteableProduct = Product & {
  variants: ProductVariant[];
  collections?: Array<ProductCollection & { collection: Pick<Collection, "id" | "slug"> }>;
};

export type QuoteableCampaign = Pick<Campaign,
  "id" | "baseEntriesPerDollar" | "currentMultiplier"
> & { entryRules: EntryRule[] };

export type StorefrontEntryQuoteLookup = Record<string, StorefrontEntryQuote>;

export function createStorefrontEntryQuoteLookup(
  campaign: QuoteableCampaign,
  products: readonly QuoteableProduct[],
  at = new Date(),
): StorefrontEntryQuoteLookup {
  const lookup: StorefrontEntryQuoteLookup = {};
  for (const product of products) {
    const collectionIds = product.collections?.map((membership) => membership.collection.id) ?? [];
    const collectionSlugs = product.collections?.map((membership) => membership.collection.slug) ?? [];
    for (const variant of product.variants) {
      lookup[variant.id] = createStorefrontEntryQuote({
        unitPriceCents: variant.priceCents ?? product.priceCents,
        at,
        campaignBaseEntriesPerCurrencyUnit: campaign.baseEntriesPerDollar,
        catalogProductMultiplier: product.entryMultiplier,
        campaignMultiplier: campaign.currentMultiplier,
        rules: campaign.entryRules,
        target: {
          productId: product.id,
          productSlug: product.slug,
          category: product.category,
          collectionIds,
          collectionSlugs,
          variantId: variant.id,
          variantSku: variant.sku,
        },
      });
    }
  }
  return lookup;
}
