import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { Browser } from "./browser.ts";
import { cellQuery, platformQuery } from "./db.ts";
import { platformInternalUrl } from "./http.ts";
import { baseDomain, routerPort, viaRouter } from "./router.ts";
import { secret } from "./secrets.ts";

/** Fresh shops for lifecycle tests (Phase 6): signed up, stocked, and bought from through the edge. */
export const operatorHeaders = { "x-operator-token": secret("PLATFORM_OPERATOR_TOKEN") };
export const password = `pw-${randomUUID()}`;

export interface Shop {
  id: string;
  handle: string;
}
export interface Event {
  step: string;
  toStatus: string | null;
  detail: Record<string, unknown>;
}

export const tenantOf = async (id: string) =>
  (await platformQuery<{ cell: string | null; status: string; plan: string }>("SELECT cell, status, plan FROM platform.tenants WHERE id = $1", [id]))[0];

export async function eventsOf(handle: string): Promise<Event[]> {
  const res = await fetch(`${platformInternalUrl}/operator/tenants/${handle}/events`, { headers: operatorHeaders });
  return ((await res.json()) as { events: Event[] }).events;
}
export const stepsOf = async (handle: string) => (await eventsOf(handle)).map((event) => event.step);

/** Polls `check` until it is true; usable in hooks, where `expect.poll` is not. */
export async function waitUntil(what: string, check: () => Promise<boolean>, timeoutMs = 60_000, intervalMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function deleteShop(shop: Shop): Promise<void> {
  const res = await fetch(`${platformInternalUrl}/operator/tenants/${shop.handle}/delete`, { method: "POST", headers: operatorHeaders });
  if (res.status !== 200) throw new Error(`deleting ${shop.handle} answered ${res.status}`);
  await waitUntil(`${shop.handle} is deleted`, async () => (await tenantOf(shop.id))?.status === "DELETED", 90_000);
}

/** A fresh starter shop in pool-1 with the given products, added by its Merchant through the edge; product ids by name. */
export async function starterShop(prefix: string, productNames: string[]): Promise<{ shop: Shop; products: string[] }> {
  const handle = `${prefix}-${randomUUID().slice(0, 8)}`;
  const res = await viaRouter(`${baseDomain}:${routerPort}`, "/signups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: randomUUID(), handle, name: `Shop ${handle}`, password, plan: "starter" }),
  });
  expect(res.status).toBe(202);
  const shop = { id: (JSON.parse(res.body) as { tenantId: string }).tenantId, handle };
  await waitUntil(`${handle} is ACTIVE`, async () => (await tenantOf(shop.id))?.status === "ACTIVE", 30_000);
  expect((await tenantOf(shop.id))?.cell).toBe("pool-1");

  const merchant = new Browser(handle);
  await waitUntil(`${handle}'s Merchant signs in`, async () => (await merchant.submit("/admin/session", { password })).headers.get("location") === "/admin", 15_000, 1_000);
  for (const name of productNames) {
    expect((await merchant.submit("/admin/products", { name, priceMinor: "1500", stock: "50" })).status).toBe(303);
  }
  const products = (
    await cellQuery<{ id: string }>("pool-1", "SELECT id FROM catalog.products WHERE tenant_id = $1 ORDER BY name", [shop.id])
  ).map((row) => row.id);
  return { shop, products };
}

export function checkoutKeyIn(html: string): string {
  const match = html.match(/name="checkoutKey" value="([^"]+)"/);
  if (!match) throw new Error("checkout form has no checkoutKey");
  return match[1]!;
}

/** A buyer's Checkout of one product through the edge; returns the Order's id. */
export async function placeOrder(handle: string, productId: string, paymentScenario: string): Promise<string> {
  const buyer = new Browser(handle);
  expect((await buyer.submit("/cart/items", { productId, action: "add" })).status).toBe(303);
  const placed = await buyer.submit("/orders", { checkoutKey: checkoutKeyIn(await buyer.html("/checkout")), paymentScenario });
  expect(placed.status).toBe(303);
  return placed.headers.get("location")!.match(/^\/orders\/([0-9a-f-]{36})/)![1]!;
}

export const ordersIn = (cell: string, tenantId: string) =>
  cellQuery<{ id: string; status: string }>(cell, "SELECT id, status FROM orders.orders WHERE tenant_id = $1 ORDER BY id", [tenantId]);

