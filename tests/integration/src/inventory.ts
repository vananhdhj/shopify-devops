import { randomUUID } from "node:crypto";
import type { Product } from "@shop/contracts";
import { query } from "./db.ts";
import { compose } from "./stack.ts";
import { catalogApiUrl, getJson } from "./http.ts";
import { secret } from "./secrets.ts";

export interface EffectResponse {
  status: number;
  body: { orderId?: string; action?: string; outcome?: string; error?: string };
}

/** Calls the catalog's internal Inventory-effect endpoint, as the worker does. */
export async function inventoryEffect(
  body: { orderId: string; action: "deduct" | "release"; items: { productId: string; quantity: number }[] },
  token: string | null = secret("INTERNAL_INVENTORY_TOKEN"),
): Promise<EffectResponse> {
  const res = await fetch(`${catalogApiUrl}/internal/inventory-effects`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-internal-token": token } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as EffectResponse["body"] };
}

export async function stockOf(productId: string): Promise<number> {
  return (await getJson<Product>(`${catalogApiUrl}/products/${productId}`)).body.stock;
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

