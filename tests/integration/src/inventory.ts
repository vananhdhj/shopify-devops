import { randomUUID } from "node:crypto";
import { query } from "./db.ts";
import { compose } from "./stack.ts";
import { catalogApiUrl } from "./http.ts";
import { secret } from "./secrets.ts";
import { tenants } from "./tenants.ts";

export interface EffectResponse {
  status: number;
  body: { orderId?: string; action?: string; outcome?: string; error?: string };
}

/**
 * Calls the catalog's internal Inventory-effect endpoint, as the worker does: no tenant context,
 * the body names the tenant (Harbor Goods unless told otherwise), and the internal token vouches.
 */
export async function inventoryEffect(
  body: { tenantId?: string; orderId: string; action: "deduct" | "release"; items: { productId: string; quantity: number }[] },
  token: string | null = secret("INTERNAL_INVENTORY_TOKEN"),
): Promise<EffectResponse> {
  const res = await fetch(`${catalogApiUrl}/internal/inventory-effects`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-internal-token": token } : {}) },
    body: JSON.stringify({ tenantId: tenants.harbor.id, ...body }),
  });
  return { status: res.status, body: (await res.json()) as EffectResponse["body"] };
}

/** A product's Stock, read as the database superuser (row-level security does not apply to it). */
export async function stockOf(productId: string): Promise<number> {
  const [row] = await query<{ stock: number }>("SELECT stock FROM catalog.products WHERE id = $1", [productId]);
  if (!row) throw new Error(`no product ${productId}`);
  return row.stock;
}

/** Resets seed products to their seed price and Stock, for tests that assert absolute Stock. */
export function reseed(): void {
  compose("run", "--rm", "seed");
}

export const newOrderId = () => randomUUID();

export function effectsFor(orderId: string) {
  return query<{ action: string; outcome: string }>(
    "SELECT action, outcome FROM catalog.inventory_effects WHERE order_id = $1 ORDER BY action",
    [orderId],
  );
}

