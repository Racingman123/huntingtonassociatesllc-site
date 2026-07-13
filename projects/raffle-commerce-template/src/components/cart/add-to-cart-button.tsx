"use client";

import { useState } from "react";
import { Check, ShoppingBag } from "lucide-react";
import { useCart } from "./cart-provider";

export type AddToCartProduct = {
  id: string;
  slug: string;
  title: string;
  image: string;
  priceCents: number;
  productType: string;
  entryMultiplier: number;
  variants: Array<{ id: string; title: string; priceCents?: number | null }>;
};

export function AddToCartButton({
  product,
  variantId,
  quantity = 1,
  className = "button button-primary",
}: {
  product: AddToCartProduct;
  variantId?: string;
  quantity?: number;
  className?: string;
}) {
  const { addItem } = useCart();
  const [feedback, setFeedback] = useState<"IDLE" | "ADDED" | "FULL">("IDLE");
  const selected = product.variants.find((variant) => variant.id === variantId) ?? product.variants[0];

  return (
    <button
      className={className}
      type="button"
      disabled={!selected}
      onClick={() => {
        if (!selected) return;
        const result = addItem({
          productId: product.id,
          variantId: selected.id,
          slug: product.slug,
          title: product.title,
          variantTitle: selected.title,
          image: product.image,
          priceCents: selected.priceCents ?? product.priceCents,
          productType: product.productType,
          entryMultiplier: product.entryMultiplier,
          quantity,
        });
        setFeedback(result);
        window.setTimeout(() => setFeedback("IDLE"), 1800);
      }}
    >
      {feedback === "ADDED" ? <Check aria-hidden="true" size={18} /> : <ShoppingBag aria-hidden="true" size={18} />}
      {feedback === "ADDED" ? "Added" : feedback === "FULL" ? "Cart has 20 items" : "Add to cart"}
    </button>
  );
}
