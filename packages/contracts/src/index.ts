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
