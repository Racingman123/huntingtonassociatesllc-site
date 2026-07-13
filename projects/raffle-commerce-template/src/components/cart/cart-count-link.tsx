"use client";

import Link from "next/link";
import { ShoppingBag } from "lucide-react";
import { useCart } from "./cart-provider";

export function CartCountLink() {
  const { itemCount, hydrated } = useCart();
  return (
    <Link className="cart-count-link" href="/cart" aria-label={`Cart with ${itemCount} items`}>
      <ShoppingBag aria-hidden="true" size={21} strokeWidth={1.8} />
      <span aria-hidden="true">{hydrated ? itemCount : 0}</span>
    </Link>
  );
}
