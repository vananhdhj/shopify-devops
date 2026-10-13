import type { LimitClass } from "./index.ts";

/**
 * The limits a shop is held to: its plan, or `internal` for a cell's synthetic shop. A routing
 * table saved by an earlier release has neither field: `starter`.
 */
export function limitClassOf(route: { plan?: string; internal?: boolean }): LimitClass {
  if (route.internal) return "internal";
  return route.plan === "plus" ? "plus" : "starter";
}

/** What a shop may use of its cell's shared resources (Phase 5), by its limit class. */
export interface PlanLimits {
  /** Requests through the edge per second, sustained (a token bucket's refill rate). */
  requestsPerSecond: number;
  /** Requests the edge lets through at once above the sustained rate (the bucket's size). */
  burst: number;
  /** Checkouts the order service runs for the shop at the same time. */
  checkoutsInFlight: number;
  /** Products in the shop's catalog. */
  products: number;
  /** The shop's Orders the outbox dispatcher admits into the settlement queue at a time. */
  admittedOrders: number;
}

/**
 * One table for every unit, so the edge, the order service, the catalog API, and the worker hold
 * a shop to the same plan. A cell's synthetic shop (`internal`) is never rate limited: it is the
 * platform measuring itself.
 */
export const planLimits: Readonly<Record<LimitClass, PlanLimits>> = {
  starter: { requestsPerSecond: 10, burst: 30, checkoutsInFlight: 3, products: 100, admittedOrders: 10 },
  plus: { requestsPerSecond: 50, burst: 150, checkoutsInFlight: 10, products: 5_000, admittedOrders: 50 },
  internal: { requestsPerSecond: Number.POSITIVE_INFINITY, burst: Number.POSITIVE_INFINITY, checkoutsInFlight: 3, products: 10, admittedOrders: 10 },
};
