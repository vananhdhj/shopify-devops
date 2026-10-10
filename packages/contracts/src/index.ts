// Wire types shared by the catalog-cart API and its consumers.
// Type-only: importers must use `import type`, so no runtime code crosses the boundary.

/** A product as served by the catalog. Prices are integer minor units (e.g. cents). */
export interface Product {
  id: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  stock: number;
}

export interface ProductList {
  products: Product[];
}

/** One line of a Cart, priced at the product's current server-owned price. */
export interface CartItem {
  productId: string;
  name: string;
  priceMinor: number;
  quantity: number;
  lineTotalMinor: number;
}

/** A Guest buyer's Cart. The shop sells in a single currency. */
export interface Cart {
  id: string;
  items: CartItem[];
  subtotalMinor: number;
  currency: string;
}

