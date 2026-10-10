import "server-only";
import type { Cart, Product, ProductList } from "@shop/contracts";

import { backendUrl } from "./backend";

const apiUrl = (path: string) => backendUrl("CATALOG_API_URL", path);

export async function listProducts(): Promise<Product[]> {
  const res = await fetch(apiUrl("/products"), { cache: "no-store" });
  if (!res.ok) throw new Error(`catalog list failed: ${res.status}`);
  return ((await res.json()) as ProductList).products;
}

export async function getProduct(id: string): Promise<Product | undefined> {
  const res = await fetch(apiUrl(`/products/${encodeURIComponent(id)}`), { cache: "no-store" });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`catalog product failed: ${res.status}`);
  return (await res.json()) as Product;
}

export async function createCart(): Promise<Cart> {
  const res = await fetch(apiUrl("/carts"), { method: "POST", cache: "no-store" });
  if (!res.ok) throw new Error(`cart create failed: ${res.status}`);
  return (await res.json()) as Cart;
}

/** Undefined when the token names no Cart (e.g. a stale cookie). */
export async function getCart(id: string): Promise<Cart | undefined> {
  const res = await fetch(apiUrl(`/carts/${encodeURIComponent(id)}`), { cache: "no-store" });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`cart read failed: ${res.status}`);
  return (await res.json()) as Cart;
}

/** Sets a line to an absolute quantity; undefined when the API refuses it (unknown product, bad quantity). */
export async function setCartItemQuantity(cartId: string, productId: string, quantity: number): Promise<Cart | undefined> {
  const res = await fetch(apiUrl(`/carts/${encodeURIComponent(cartId)}/items/${encodeURIComponent(productId)}`), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quantity }),
    cache: "no-store",
  });
  if (res.status === 404 || res.status === 400) return undefined;
  if (!res.ok) throw new Error(`cart update failed: ${res.status}`);
  return (await res.json()) as Cart;
}

