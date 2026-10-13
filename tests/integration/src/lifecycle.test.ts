import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@shop/tenancy";
import { asIdentity, platformQuery, query } from "./db.ts";
import { api, catalogApiUrl, orderServiceUrl, platformInternalUrl } from "./http.ts";
import { baseDomain, routerPort, shopFetch, viaRouter } from "./router.ts";
import { secret } from "./secrets.ts";
import { compose, restartService } from "./stack.ts";
import { tenants } from "./tenants.ts";

const platformHost = `${baseDomain}:${routerPort}`;

const tenantTables = [
  "catalog.cart_items",
  "catalog.carts",
  "catalog.inventory_effects",
  "catalog.products",
  "orders.order_events",
  "orders.order_items",
  "orders.orders",
  "orders.outbox",
];

function operator(path: string, init: RequestInit = {}, token: string | null = secret("PLATFORM_OPERATOR_TOKEN")) {
  const headers = new Headers(init.headers);
  if (token) headers.set("x-operator-token", token);
  return fetch(`${platformInternalUrl}${path}`, { ...init, headers });
}

const act = (handle: string, action: string) => operator(`/operator/tenants/${handle}/${action}`, { method: "POST" });

const statusOf = async (tenantId: string) =>
  (await platformQuery<{ status: string }>("SELECT status FROM platform.tenants WHERE id = $1", [tenantId]))[0]?.status;

const stepCount = async (tenantId: string, step: string) =>
  (await platformQuery<{ n: number }>("SELECT count(*)::int AS n FROM platform.tenant_events WHERE tenant_id = $1 AND step = $2", [
    tenantId,
    step,
  ]))[0]!.n;

/** A shop signed up through the router and fully provisioned. */
async function signedUpShop(): Promise<TenantContext> {
  const handle = `l-${randomUUID().slice(0, 8)}`;
  const name = `Lifecycle ${handle}`;
  const res = await viaRouter(platformHost, "/signups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: randomUUID(), handle, name, password: "a-long-enough-password" }),
  });
  const { tenantId } = JSON.parse(res.body) as { tenantId: string };
  await expect.poll(() => stepCount(tenantId, "checked"), { timeout: 15_000, interval: 250 }).toBe(1);
  return { id: tenantId, handle, name, credentialVersion: 1, plan: "starter" };
}

/** Gives a shop a product, a Cart holding it, and Orders, so every one of its eight tables has rows. */
async function stockedShop(): Promise<{ shop: TenantContext; pendingOrderId: string }> {
  const shop = await signedUpShop();
  const json = { "content-type": "application/json" };
  const product = (await (
    await api(`${catalogApiUrl}/admin/products`, {
      method: "POST",
      headers: { ...json, "x-admin-token": secret("ADMIN_SERVICE_TOKEN") },
      body: JSON.stringify({ name: "Lifecycle Lamp", priceMinor: 1000, stock: 10 }),
    }, shop)
  ).json()) as { id: string };

  const order = async (scenario: string) => {
    const cart = (await (await api(`${catalogApiUrl}/carts`, { method: "POST" }, shop)).json()) as { id: string };
    await api(`${catalogApiUrl}/carts/${cart.id}/items/${product.id}`, { method: "PUT", headers: json, body: JSON.stringify({ quantity: 1 }) }, shop);
    const accepted = await api(`${orderServiceUrl}/checkout`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ cartToken: cart.id, checkoutKey: `k-${randomUUID()}`, paymentScenario: scenario }),
    }, shop);
    return ((await accepted.json()) as { orderId: string }).orderId;
  };
  const confirmed = await order("approve");
  await expect
    .poll(async () => (await query<{ status: string }>("SELECT status FROM orders.orders WHERE id = $1", [confirmed]))[0]?.status, {
      timeout: 15_000,
    })
    .toBe("CONFIRMED");
  // A Cart that never became an Order, so cart rows exist too.
  const open = (await (await api(`${catalogApiUrl}/carts`, { method: "POST" }, shop)).json()) as { id: string };
  await api(`${catalogApiUrl}/carts/${open.id}/items/${product.id}`, { method: "PUT", headers: json, body: JSON.stringify({ quantity: 2 }) }, shop);
  // Slow payment: still Pending for about three seconds.
  const pendingOrderId = await order("slow");
  return { shop, pendingOrderId };
}

async function rowsOf(tenantId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tenantTables) {
    counts[table] = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantId]))[0]!.n;
  }
  return counts;
}

const allZero = Object.fromEntries(tenantTables.map((table) => [table, 0]));

describe("operator actions", () => {
  it("refuse a caller without the operator token", async () => {
    expect((await operator("/operator/tenants", {}, null)).status).toBe(401);
    expect((await operator("/operator/tenants/harbor/events", {}, "wrong")).status).toBe(401);
    expect((await operator("/operator/tenants/harbor/suspend", { method: "POST" }, null)).status).toBe(401);
    expect(await statusOf(tenants.harbor.id)).toBe("ACTIVE");
  });

  it("list shops with their status and cell", async () => {
    const list = (await (await operator("/operator/tenants")).json()) as { tenants: { handle: string; status: string; cell: string }[] };
    expect(list.tenants).toContainEqual(expect.objectContaining({ handle: "harbor", status: "ACTIVE", cell: "pool-1" }));
  });

  it("suspend a shop at the router, keep its data, let a Pending order settle, and reinstate it", async () => {
    const { shop, pendingOrderId } = await stockedShop();
    expect((await act(shop.handle, "suspend")).status).toBe(200);
    expect((await act(shop.handle, "suspend")).status).toBe(409);

    await expect
      .poll(async () => (await shopFetch("/", {}, shop.handle)).status, { timeout: 10_000, interval: 250 })
      .toBe(503);
    await expect
      .poll(async () => (await query<{ status: string }>("SELECT status FROM orders.orders WHERE id = $1", [pendingOrderId]))[0]?.status, {
        timeout: 15_000,
      })
      .toBe("CONFIRMED");
    expect((await rowsOf(shop.id))["catalog.products"]).toBe(1);

    expect((await act(shop.handle, "reinstate")).status).toBe(200);
    await expect
      .poll(async () => (await shopFetch("/", {}, shop.handle)).status, { timeout: 10_000, interval: 250 })
      .toBe(200);

    const events = (await (await operator(`/operator/tenants/${shop.handle}/events`)).json()) as { events: { step: string; actor: string }[] };
    expect(events.events.filter((event) => event.actor === "operator").map((event) => event.step)).toEqual(["suspend", "reinstate"]);
  });

  it("delete a shop: nothing of it is left in the cell, the other shops are untouched, and the record stays", async () => {
    const harborBefore = await rowsOf(tenants.harbor.id);
    const { shop } = await stockedShop();
    const before = await rowsOf(shop.id);
    for (const table of tenantTables) expect.soft(before[table], table).toBeGreaterThan(0);

    expect((await act(shop.handle, "delete")).status).toBe(200);
    await expect
      .poll(async () => (await shopFetch("/", {}, shop.handle)).status, { timeout: 10_000, interval: 250 })
      .toBe(404);
    await expect.poll(() => statusOf(shop.id), { timeout: 30_000, interval: 500 }).toBe("DELETED");

    expect(await rowsOf(shop.id)).toEqual(allZero);
    const [deleted] = await platformQuery<{ detail: { verified: Record<string, number> } }>(
      "SELECT detail FROM platform.tenant_events WHERE tenant_id = $1 AND step = 'deleted'",
      [shop.id],
    );
    expect(deleted?.detail.verified).toEqual(allZero);
    expect(await stepCount(shop.id, "purged")).toBeGreaterThanOrEqual(1);
    expect(await rowsOf(tenants.harbor.id)).toEqual(harborBefore);
    expect((await act(shop.handle, "reinstate")).status).toBe(409);
  });

  describe("when the lifecycle worker stops mid-deletion", () => {
    afterAll(() => restartService("platform-worker"));

    it("finishes the deletion after it comes back, with nothing left behind", async () => {
      const { shop } = await stockedShop();
      expect((await act(shop.handle, "delete")).status).toBe(200);
      // Stop it once the first purge pass is recorded, before the verifying second pass.
      await expect.poll(() => stepCount(shop.id, "purged"), { timeout: 15_000, interval: 100 }).toBeGreaterThanOrEqual(1);
      compose("stop", "platform-worker");
      expect(await statusOf(shop.id)).toBe("DELETING");

      restartService("platform-worker");
      await expect.poll(() => statusOf(shop.id), { timeout: 30_000, interval: 500 }).toBe("DELETED");
      expect(await rowsOf(shop.id)).toEqual(allZero);
      expect(await stepCount(shop.id, "deleted")).toBe(1);
    });
  });
});

describe("the cell's side of deletion", () => {
  it("refuses a purge without the cell token, even with a valid tenant context", async () => {
    for (const base of [catalogApiUrl, orderServiceUrl]) {
      const res = await api(`${base}/internal/tenants/${tenants.harbor.id}/purge`, { method: "POST" });
      expect.soft(res.status, base).toBe(401);
    }
    expect((await rowsOf(tenants.harbor.id))["catalog.products"]).toBeGreaterThan(0);
  });

  it("gives the runtime identities no DELETE outside the purge functions", async () => {
    const attempt = (identity: "catalog" | "orders", sql: string) =>
      asIdentity(identity, async (db) => {
        try {
          await db.query("BEGIN");
          await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenants.harbor.id]);
          await db.query(sql);
          return "allowed";
        } catch (err) {
          return (err as { code?: string }).code;
        } finally {
          await db.query("ROLLBACK");
        }
      });
    expect(await attempt("catalog", "DELETE FROM catalog.products")).toBe("42501");
    expect(await attempt("orders", "DELETE FROM orders.orders")).toBe("42501");
  });
});
