import type { InventoryEffectLine, InventoryEffectOutcome, InventoryEffectResult } from "@shop/contracts";

export interface InventoryClient {
  deduct(orderId: string, items: InventoryEffectLine[]): Promise<InventoryEffectOutcome>;
  /** Returns exactly what the Order's applied deduction took; no items needed. */
  release(orderId: string): Promise<InventoryEffectOutcome>;
}

/**
 * Calls the catalog's internal Inventory-effect endpoint with a bounded wait. Any failure
 * throws, so the job retries; the endpoint's per-(Order, action) deduplication makes the
 * retry safe.
 */
export function inventoryClient(catalogApiUrl: string, internalToken: string): InventoryClient {
  async function apply(orderId: string, action: "deduct" | "release", items: InventoryEffectLine[]) {
    const res = await fetch(`${catalogApiUrl}/internal/inventory-effects`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": internalToken },
      body: JSON.stringify({ orderId, action, items }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) throw new Error(`inventory ${action} for ${orderId} answered ${res.status}`);
    return ((await res.json()) as InventoryEffectResult).outcome;
  }
  return {
    deduct: (orderId, items) => apply(orderId, "deduct", items),
    release: (orderId) => apply(orderId, "release", []),
  };
}
