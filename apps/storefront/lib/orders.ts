import "server-only";
import type { CheckoutAccepted, CheckoutError, CheckoutRequest, Order } from "@shop/contracts";
import { backendUrl } from "./backend";

const apiUrl = (path: string) => backendUrl("ORDER_SERVICE_URL", path);

export type CheckoutOutcome =
  | { outcome: "accepted"; order: CheckoutAccepted }
  | { outcome: "refused"; reason: CheckoutError };

export async function submitCheckout(request: CheckoutRequest): Promise<CheckoutOutcome> {
  const res = await fetch(apiUrl("/checkout"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    cache: "no-store",
  });
  if (res.status === 202) return { outcome: "accepted", order: (await res.json()) as CheckoutAccepted };
  if (res.status >= 500 && res.status !== 503) throw new Error(`checkout failed: ${res.status}`);
  return { outcome: "refused", reason: ((await res.json()) as { error: CheckoutError }).error };
}

/** Undefined for an unknown Order or a wrong Order token; the two are indistinguishable by design. */
export async function getOrder(id: string, orderToken: string): Promise<Order | undefined> {
  const res = await fetch(apiUrl(`/orders/${encodeURIComponent(id)}`), {
    headers: { "x-order-token": orderToken },
    cache: "no-store",
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`order read failed: ${res.status}`);
  return (await res.json()) as Order;
}
