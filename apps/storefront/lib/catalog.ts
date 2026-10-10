import "server-only";
import type { Product, ProductList } from "@shop/contracts";

// Server-side only: the browser never learns this address or calls the API itself.
function apiUrl(path: string): string {
  const base = process.env.CATALOG_API_URL;
  if (!base) throw new Error("missing required environment variable CATALOG_API_URL");
  return `${base}${path}`;
}

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
