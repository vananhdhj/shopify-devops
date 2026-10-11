import type { InventoryEffectLine, InventoryEffectOutcome, InventoryEffectResult } from "@shop/contracts";

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
    const res = await fetch(`${catalogApiUrl}/internal/inventory-effects`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": internalToken },
      body: JSON.stringify({ tenantId, orderId, action, items }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) throw new Error(`inventory ${action} for ${orderId} answered ${res.status}`);
    return ((await res.json()) as InventoryEffectResult).outcome;
  }
  return {
    deduct: (tenantId, orderId, items) => apply(tenantId, orderId, "deduct", items),
    release: (tenantId, orderId) => apply(tenantId, orderId, "release", []),
  };
}
