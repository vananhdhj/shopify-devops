import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { Browser } from "./browser.ts";
import { cellQuery, platformQuery } from "./db.ts";
import { platformInternalUrl } from "./http.ts";
import { baseDomain, routerPort, shopFetch, viaRouter } from "./router.ts";
import { secret } from "./secrets.ts";
import { compose, restartService, secondCellRunning } from "./stack.ts";
import { tenants } from "./tenants.ts";

/**
 * Two real cells: pool-1 (Harbor Goods, Meadow Supply, every starter shop) and dedicated-1, a
 * complete second cell with its own database, queue, APIs, and storefront. Runs only with the
 * second cell up (`make dev-up CELLS=2`).
 */
const twoCells = secondCellRunning();
if (!twoCells) console.warn("containment tests skipped: the second cell is not running (make dev-up CELLS=2)");

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

const operator = (path: string) =>
  fetch(`${platformInternalUrl}${path}`, { method: "POST", headers: { "x-operator-token": secret("PLATFORM_OPERATOR_TOKEN") } });

const tenantOf = async (id: string) =>
  (await platformQuery<{ handle: string; cell: string | null; status: string }>(
    "SELECT handle, cell, status FROM platform.tenants WHERE id = $1",
    [id],
  ))[0];

async function rowsIn(cell: string, tenantId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tenantTables) {
    counts[table] = (await cellQuery<{ n: number }>(cell, `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantId]))[0]!.n;
  }
  return counts;
}

async function signup(plan: string, password = "a-long-enough-password") {
  const handle = `p-${randomUUID().slice(0, 8)}`;
  const res = await viaRouter(platformHost, "/signups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: randomUUID(), handle, name: `Plus ${handle}`, password, plan }),
  });
  return { status: res.status, handle, body: JSON.parse(res.body) as { tenantId?: string; error?: string } };
}

/** Polls `check` until it is true; usable in hooks, where `expect.poll` is not. */
async function waitUntil(what: string, check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Deletes a shop and waits until the control plane has verified it gone from its cell. */
async function deleteShop(tenantId: string, handle: string): Promise<void> {
  const res = await operator(`/operator/tenants/${handle}/delete`);
  if (res.status !== 200) throw new Error(`deleting ${handle} answered ${res.status}`);
  await waitUntil(`${handle} is deleted`, async () => (await tenantOf(tenantId))?.status === "DELETED");
}

const statusOf = async (handle: string) => (await shopFetch("/", {}, handle)).status;

/** The fleet view's readiness of each cell's APIs. */
async function apisOf(): Promise<Record<string, { catalog: string; orders: string } | null>> {
  const res = await fetch(`${platformInternalUrl}/operator/cells`, { headers: { "x-operator-token": secret("PLATFORM_OPERATOR_TOKEN") } });
  const { cells } = (await res.json()) as { cells: { id: string; apis: { catalog: string; orders: string } | null }[] };
  return Object.fromEntries(cells.map((cell) => [cell.id, cell.apis]));
}

describe.skipIf(!twoCells)("two cells", () => {
  const password = `pw-${randomUUID()}`;
  let plus: { id: string; handle: string };

  beforeAll(async () => {
    // A plus shop left by an earlier, interrupted run would hold dedicated-1: free it first (its
    // synthetic shop stays: it is outside the capacity).
    const leftovers = await platformQuery<{ id: string; handle: string }>(
      "SELECT id, handle FROM platform.tenants WHERE cell = 'dedicated-1' AND status IN ('ACTIVE', 'SUSPENDED') AND NOT internal",
    );
    for (const shop of leftovers) await deleteShop(shop.id, shop.handle);
    await waitUntil(
      "dedicated-1 holds no shop",
      async () => (await platformQuery("SELECT 1 FROM platform.tenants WHERE cell = 'dedicated-1' AND status <> 'DELETED' AND NOT internal")).length === 0,
    );
  }, 180_000);

  it("gives a plus shop dedicated-1 of its own, served through the edge, with its rows only there", async () => {
    const { status, handle, body } = await signup("plus", password);
    expect(status).toBe(202);
    plus = { id: body.tenantId!, handle };
    expect((await tenantOf(plus.id))?.cell).toBe("dedicated-1");
    await expect.poll(async () => (await tenantOf(plus.id))?.status, { timeout: 15_000, interval: 250 }).toBe("ACTIVE");

    // The Merchant signs in through dedicated-1's storefront (checked with that cell's own token)
    // and adds a product; a buyer sees it.
    const merchant = new Browser(handle);
    await expect
      .poll(async () => (await merchant.submit("/admin/session", { password })).headers.get("location"), { timeout: 15_000 })
      .toBe("/admin");
    expect((await merchant.submit("/admin/products", { name: "Dedicated Lamp", priceMinor: "4200", stock: "5" })).status).toBe(303);
    expect(await new Browser(handle).html("/")).toContain("Dedicated Lamp");

    expect((await rowsIn("dedicated-1", plus.id))["catalog.products"]).toBe(1);
    expect(await rowsIn("pool-1", plus.id)).toEqual(Object.fromEntries(tenantTables.map((table) => [table, 0])));

    // The only dedicated cell is taken.
    expect(await signup("plus")).toMatchObject({ status: 409, body: { error: "no_capacity" } });
  }, 60_000);

  it("keeps pool-1's shops serving while dedicated-1's database is down, shows it in the fleet view, and recovers dedicated-1", async () => {
    compose("stop", "dedicated-1-postgres");
    try {
      await expect.poll(() => statusOf(plus.handle), { timeout: 30_000, interval: 500 }).toBeGreaterThanOrEqual(500);
      // The fleet view marks dedicated-1's APIs not ready, and only those.
      await expect
        .poll(async () => {
          const apis = await apisOf();
          return { pool: apis["pool-1"], dedicated: apis["dedicated-1"] };
        }, { timeout: 15_000, interval: 500 })
        .toEqual({ pool: { catalog: "ready", orders: "ready" }, dedicated: { catalog: "not_ready", orders: "not_ready" } });
      for (let i = 0; i < 10; i++) {
        for (const shop of [tenants.harbor, tenants.meadow]) expect.soft(await statusOf(shop.handle), shop.handle).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      restartService("dedicated-1-postgres");
    }
    await expect.poll(() => statusOf(plus.handle), { timeout: 60_000, interval: 1_000 }).toBe(200);
    expect((await apisOf())["dedicated-1"]).toEqual({ catalog: "ready", orders: "ready" });
  }, 120_000);

  it("answers 503 for dedicated-1's shop when its storefront is down, and only for it", async () => {
    compose("stop", "dedicated-1-storefront");
    try {
      await expect
        .poll(
          async () => {
            const res = await shopFetch("/", {}, plus.handle);
            return { status: res.status, text: await res.text() };
          },
          { timeout: 15_000, interval: 500 },
        )
        .toEqual({ status: 503, text: "This service is temporarily unavailable. Try again in a few seconds.\n" });
      expect(await statusOf(tenants.harbor.handle)).toBe(200);
    } finally {
      restartService("dedicated-1-storefront");
    }
    await expect.poll(() => statusOf(plus.handle), { timeout: 60_000, interval: 1_000 }).toBe(200);
  }, 120_000);

  it("purges a deleted plus shop from dedicated-1 and leaves pool-1 untouched", async () => {
    const harborBefore = await rowsIn("pool-1", tenants.harbor.id);
    await deleteShop(plus.id, plus.handle);
    expect(await rowsIn("dedicated-1", plus.id)).toEqual(Object.fromEntries(tenantTables.map((table) => [table, 0])));
    expect(await rowsIn("pool-1", tenants.harbor.id)).toEqual(harborBefore);
    // dedicated-1 is free again: a new plus shop takes it (and is deleted once active, to free it).
    const next = await signup("plus");
    expect(next.status).toBe(202);
    expect((await tenantOf(next.body.tenantId!))?.cell).toBe("dedicated-1");
    await expect.poll(async () => (await tenantOf(next.body.tenantId!))?.status, { timeout: 15_000, interval: 250 }).toBe("ACTIVE");
    await deleteShop(next.body.tenantId!, next.handle);
  }, 150_000);
});
