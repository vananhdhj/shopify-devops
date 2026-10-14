import type { InventoryEffectLine, InventoryEffectOutcome, InventoryEffectResult } from "@shop/contracts";
import { SpanKind, traceHeaders, withSpan } from "@shop/service-kit";

export interface InventoryClient {
  deduct(tenantId: string, orderId: string, items: InventoryEffectLine[]): Promise<InventoryEffectOutcome>;
  /** Returns exactly what the Order's applied deduction took; no items needed. */
  release(tenantId: string, orderId: string): Promise<InventoryEffectOutcome>;
}

/**
 * Calls the catalog's internal Inventory-effect endpoint with a bounded wait, naming the Order's
 * tenant (the internal token is what makes the catalog trust it). Any failure throws, so the
 * job retries; the endpoint's per-(tenant, Order, action) deduplication makes the retry safe.
 */
export function inventoryClient(catalogApiUrl: string, internalToken: string): InventoryClient {
  async function apply(tenantId: string, orderId: string, action: "deduct" | "release", items: InventoryEffectLine[]) {
    return withSpan(`POST catalog inventory ${action}`, { kind: SpanKind.CLIENT }, async (span) => {
      const res = await fetch(`${catalogApiUrl}/internal/inventory-effects`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": internalToken, ...traceHeaders() },
        body: JSON.stringify({ tenantId, orderId, action, items }),
        signal: AbortSignal.timeout(3_000),
      });
      span.setAttribute("http.response.status_code", res.status);
      if (!res.ok) throw new Error(`inventory ${action} for ${orderId} answered ${res.status}`);
      return ((await res.json()) as InventoryEffectResult).outcome;
    });
  }
  return {
    deduct: (tenantId, orderId, items) => apply(tenantId, orderId, "deduct", items),
    release: (tenantId, orderId) => apply(tenantId, orderId, "release", []),
  };
}
