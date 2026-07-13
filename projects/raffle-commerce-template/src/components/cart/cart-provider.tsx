"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";

export type CartItem = {
  productId: string;
  variantId: string;
  slug: string;
  title: string;
  variantTitle: string;
  image: string;
  priceCents: number;
  productType: string;
  entryMultiplier: number;
  quantity: number;
};

type AddCartItem = Omit<CartItem, "quantity"> & { quantity?: number };

type CartContextValue = {
  items: CartItem[];
  itemCount: number;
  subtotalCents: number;
  hydrated: boolean;
  addItem: (item: AddCartItem) => "ADDED" | "FULL";
  updateQuantity: (productId: string, variantId: string, quantity: number) => void;
  removeItem: (productId: string, variantId: string) => void;
  clearCart: () => void;
};

const CartContext = createContext<CartContextValue | null>(null);
const STORAGE_KEY = "giveaway-template-cart-v1";
const CART_EVENT = "giveaway-template-cart-change";
const MAX_LINE_QUANTITY = 20;
const MAX_CART_LINES = 20;
const EMPTY_CART: CartItem[] = [];
let cachedRaw: string | null | undefined;
let cachedItems: CartItem[] = EMPTY_CART;

function validStoredItem(value: unknown): value is CartItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CartItem>;
  return (
    typeof item.productId === "string" && item.productId.length <= 191 &&
    typeof item.variantId === "string" && item.variantId.length <= 191 &&
    typeof item.slug === "string" && item.slug.length <= 200 &&
    typeof item.title === "string" && item.title.length <= 300 &&
    typeof item.variantTitle === "string" && item.variantTitle.length <= 300 &&
    typeof item.image === "string" && item.image.length <= 2_048 &&
    Number.isSafeInteger(item.priceCents) &&
    item.priceCents! > 0 &&
    typeof item.productType === "string" && ["PHYSICAL", "DIGITAL"].includes(item.productType) &&
    Number.isSafeInteger(item.entryMultiplier) &&
    item.entryMultiplier! > 0 &&
    Number.isSafeInteger(item.quantity) &&
    item.quantity! > 0 &&
    item.quantity! <= MAX_LINE_QUANTITY
  );
}

function readCart(): CartItem[] {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === cachedRaw) return cachedItems;
  cachedRaw = raw;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cachedItems = Array.isArray(parsed)
      ? parsed.filter(validStoredItem).slice(0, MAX_CART_LINES)
      : EMPTY_CART;
  } catch {
    cachedItems = EMPTY_CART;
  }
  return cachedItems;
}

function writeCart(items: CartItem[]) {
  const raw = JSON.stringify(items);
  cachedRaw = raw;
  cachedItems = items;
  window.localStorage.setItem(STORAGE_KEY, raw);
  window.dispatchEvent(new Event(CART_EVENT));
}

function subscribeToCart(onStoreChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cachedRaw = undefined;
    onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CART_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CART_EVENT, onStoreChange);
  };
}

function subscribeToHydration() {
  return () => undefined;
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const items = useSyncExternalStore(subscribeToCart, readCart, () => EMPTY_CART);
  const hydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);

  const addItem = useCallback((item: AddCartItem) => {
    const quantity = Math.min(MAX_LINE_QUANTITY, Math.max(1, item.quantity ?? 1));
    const current = readCart();
    const index = current.findIndex(
        (existing) => existing.productId === item.productId && existing.variantId === item.variantId,
    );
    if (index === -1) {
      if (current.length >= MAX_CART_LINES) return "FULL";
      writeCart([...current, { ...item, quantity }]);
      return "ADDED";
    }
    writeCart(current.map((existing, itemIndex) =>
        itemIndex === index
          ? { ...existing, quantity: Math.min(MAX_LINE_QUANTITY, existing.quantity + quantity) }
          : existing,
    ));
    return "ADDED";
  }, []);

  const updateQuantity = useCallback((productId: string, variantId: string, quantity: number) => {
    if (quantity <= 0) {
      writeCart(readCart().filter(
        (item) => !(item.productId === productId && item.variantId === variantId),
      ));
      return;
    }
    const safeQuantity = Math.min(MAX_LINE_QUANTITY, Math.max(1, Math.floor(quantity)));
    writeCart(readCart().map((item) =>
      item.productId === productId && item.variantId === variantId
        ? { ...item, quantity: safeQuantity }
        : item,
    ));
  }, []);

  const removeItem = useCallback((productId: string, variantId: string) => {
    writeCart(readCart().filter(
      (item) => !(item.productId === productId && item.variantId === variantId),
    ));
  }, []);

  const clearCart = useCallback(() => writeCart([]), []);

  const value = useMemo<CartContextValue>(() => ({
    items,
    itemCount: items.reduce((total, item) => total + item.quantity, 0),
    subtotalCents: items.reduce((total, item) => total + item.priceCents * item.quantity, 0),
    hydrated,
    addItem,
    updateQuantity,
    removeItem,
    clearCart,
  }), [items, hydrated, addItem, updateQuantity, removeItem, clearCart]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const value = useContext(CartContext);
  if (!value) throw new Error("useCart must be used inside CartProvider");
  return value;
}
