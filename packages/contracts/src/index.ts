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


/** The simulated payment outcome chosen at Checkout; no money or card data exists anywhere. */
export type PaymentScenario = "approve" | "decline" | "slow";

export type OrderStatus = "PENDING" | "CONFIRMED" | "REJECTED_OUT_OF_STOCK" | "REJECTED_PAYMENT" | "FULFILLED";

export interface CheckoutRequest {
  cartToken: string;
  /** Client-generated; retries of one Checkout reuse it and get the same Order back. */
  checkoutKey: string;
  paymentScenario: PaymentScenario;
}

/** Why a Checkout created no Order. Distinct from a Rejected order, which exists and is terminal. */
export type CheckoutRefusal = "cart_not_found" | "cart_empty" | "checkout_key_reused" | "cart_already_ordered";

/** Every `error` code POST /checkout can answer with. */
export type CheckoutError = CheckoutRefusal | "dependency_unavailable" | "invalid_request";

/** Returned with 202: the Order exists and is Pending, not yet confirmed. */
export interface CheckoutAccepted {
  orderId: string;
  orderToken: string;
  status: OrderStatus;
}

/** One line of an Order's immutable snapshot, priced as it was at Checkout. */
export interface OrderItem {
  productId: string;
  name: string;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
}

export interface Order {
  id: string;
  status: OrderStatus;
  paymentScenario: PaymentScenario;
  items: OrderItem[];
  subtotalMinor: number;
  currency: string;
  createdAt: string;
}
