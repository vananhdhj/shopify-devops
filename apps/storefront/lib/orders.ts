import "server-only";
import type { CheckoutAccepted, CheckoutError, CheckoutRequest, Order } from "@shop/contracts";
import { backendFetch } from "./backend";

export type CheckoutOutcome =
  | { outcome: "accepted"; order: CheckoutAccepted }
  | { outcome: "refused"; reason: CheckoutError };

export async function submitCheckout(request: CheckoutRequest): Promise<CheckoutOutcome> {
  const res = await backendFetch("ORDER_SERVICE_URL", "/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (res.status === 202) return { outcome: "accepted", order: (await res.json()) as CheckoutAccepted };
  if (res.status >= 500 && res.status !== 503) throw new Error(`checkout failed: ${res.status}`);
  return { outcome: "refused", reason: ((await res.json()) as { error: CheckoutError }).error };
}

/** Undefined for an unknown Order or a wrong Order token; the two are indistinguishable by design. */
export async function getOrder(id: string, orderToken: string): Promise<Order | undefined> {
  const res = await backendFetch("ORDER_SERVICE_URL", `/orders/${encodeURIComponent(id)}`, {
    headers: { "x-order-token": orderToken },
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`order read failed: ${res.status}`);
  return (await res.json()) as Order;
}
