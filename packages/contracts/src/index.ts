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

export type InventoryEffectAction = "deduct" | "release";

export type InventoryEffectOutcome = "applied" | "insufficient_stock" | "nothing_to_release";

export interface InventoryEffectLine {
  productId: string;
  quantity: number;
}

/**
 * Body of the catalog's internal POST /internal/inventory-effects (worker only). A release
 * returns exactly what the Order's applied deduction took, so its `items` are ignored.
 */
export interface InventoryEffectRequest {
  /** The Order's tenant; trusted because only the worker holds the internal token. */
  tenantId: string;
  orderId: string;
  action: InventoryEffectAction;
  items: InventoryEffectLine[];
}

export interface InventoryEffectResult {
  orderId: string;
  action: InventoryEffectAction;
  outcome: InventoryEffectOutcome;
}

/** One row of the Merchant's order list. */
export interface AdminOrderSummary {
  id: string;
  status: OrderStatus;
  paymentScenario: PaymentScenario;
  itemCount: number;
  subtotalMinor: number;
  currency: string;
  createdAt: string;
}

export interface AdminOrderList {
  /** Confirmed orders (awaiting fulfillment) first, then newest first. */
  orders: AdminOrderSummary[];
  /** True when more Orders exist than were returned. */
  truncated: boolean;
}

/** The Merchant's only status action: Confirmed → Fulfilled. */
export interface AdminStatusChange {
  status: "FULFILLED";
}

export interface NewProduct {
  name: string;
  description?: string;
  priceMinor: number;
  stock: number;
}


/** Where a shop stands in its lifecycle, as the control plane's registry records it. */
export type TenantStatus = "PROVISIONING" | "ACTIVE" | "SUSPENDED" | "DELETING" | "DELETED";

/** One shop as the router needs it: enough to route a request and sign its tenant context. */
export interface TenantRoute {
  id: string;
  handle: string;
  name: string;
  status: TenantStatus;
  /** Changes when the shop's Merchant credential changes; sessions are bound to it. */
  credentialVersion: number;
  /** The cell holding the shop's data; null until provisioning places it. */
  cell: string | null;
}

/** A registered cell as the edge needs it: where to send its shops' requests. */
export interface CellRoute {
  id: string;
  storefrontUrl: string;
}

/** What a shop pays for: `starter` shares a pooled cell, `plus` gets a dedicated cell of its own. */
export type Plan = "starter" | "plus";

/** What each cell is for: the release canary, shared by starter shops, or one plus shop alone. */
export type CellRole = "canary" | "pooled" | "dedicated";

/** Sent by a cell once its units are healthy: it enters (or updates) the control plane's cell directory. */
export interface CellRegistration {
  role: CellRole;
  /** The most shops the cell takes; always 1 for a dedicated cell. */
  capacity: number;
  storefrontUrl: string;
  catalogUrl: string;
  ordersUrl: string;
}

/** Asked by a cell's storefront when a Merchant signs in; the credential never leaves the control plane. */
export interface MerchantSignInRequest {
  tenantId: string;
  password: string;
}

/** The answer: whether the password is this active shop's, and the credential version a session binds to. */
export type MerchantSignInResult = { ok: true; credentialVersion: number } | { ok: false };

/** The control plane's routing table: every shop that has not been deleted, and every registered cell. */
export interface TenantRouteTable {
  tenants: TenantRoute[];
  cells: CellRoute[];
}
