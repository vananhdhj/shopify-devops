import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser } from "./browser.ts";
import { empty, shopChecksums } from "./cell-data.ts";
import { platformQuery } from "./db.ts";
import { platformInternalUrl } from "./http.ts";
import { type Shop, deleteShop, eventsOf, operatorHeaders, ordersIn, placeOrder, starterShop, stepsOf, tenantOf, waitUntil } from "./shops.ts";
import { compose, restartService, secondCellRunning } from "./stack.ts";

/**
 * Phase 6's tenant move: fresh starter shops in pool-1 moved to dedicated-1 by the control plane
 * (`POST /operator/tenants/:handle/move`), through each cell's export, import, checksum, and purge
 * endpoints. Runs only with the second cell up (`make dev-up CELLS=2`); dedicated-1 is freed first
 * and the shops are deleted after.
 */
const twoCells = secondCellRunning();
if (!twoCells) console.warn("move tests skipped: the second cell is not running (make dev-up CELLS=2)");

function requestMove(handle: string, cell: string): Promise<Response> {
  return fetch(`${platformInternalUrl}/operator/tenants/${handle}/move`, {
    method: "POST",
    headers: { ...operatorHeaders, "content-type": "application/json" },
    body: JSON.stringify({ cell }),
  });
}

describe.skipIf(!twoCells)("tenant move", () => {
  const shops: Shop[] = [];

  beforeAll(async () => {
    // dedicated-1 must be free: a plus shop an earlier, interrupted run left there is deleted.
    const leftovers = await platformQuery<Shop>(
      "SELECT id, handle FROM platform.tenants WHERE cell = 'dedicated-1' AND status IN ('ACTIVE', 'SUSPENDED') AND NOT internal",
    );
    for (const shop of leftovers) await deleteShop(shop);
  }, 180_000);

  afterAll(async () => {
    for (const shop of shops) await deleteShop(shop);
  }, 180_000);

  it("undoes a move whose target cannot import: the shop stays ACTIVE in pool-1, and nothing of it is left in dedicated-1", async () => {
    const { shop, products } = await starterShop("mv", ["Moving Lamp", "Moving Rug"]);
    shops.push(shop);
    const order = await placeOrder(shop.handle, products[0]!, "approve");
    await expect.poll(async () => (await ordersIn("pool-1", shop.id)).find((o) => o.id === order)?.status, { timeout: 20_000, interval: 250 }).toBe("CONFIRMED");
    const before = await shopChecksums("pool-1", shop.id);

    compose("stop", "dedicated-1-catalog-cart-api");
    try {
      expect((await requestMove(shop.handle, "dedicated-1")).status).toBe(202);
      await expect.poll(async () => (await tenantOf(shop.id))?.status, { timeout: 30_000, interval: 250 }).toBe("ACTIVE");
      expect(await stepsOf(shop.handle)).toContain("move_failed");
      expect((await tenantOf(shop.id))?.cell).toBe("pool-1");
      // Served and writable in pool-1 again (from the edge's next routing refresh).
      const buyer = new Browser(shop.handle);
      await expect.poll(async () => (await buyer.submit("/cart/items", { productId: products[1]!, action: "add" })).status, { timeout: 15_000, interval: 1_000 }).toBe(303);
    } finally {
      restartService("dedicated-1-catalog-cart-api");
    }
    // The copy is purged from dedicated-1 once its API is back.
    await expect.poll(() => stepsOf(shop.handle), { timeout: 60_000, interval: 500 }).toContain("move_undone");
    expect(empty(await shopChecksums("dedicated-1", shop.id))).toBe(true);
    const after = await shopChecksums("pool-1", shop.id);
    expect(after["orders.orders"]).toEqual(before["orders.orders"]);
    expect(after["catalog.products"]).toEqual(before["catalog.products"]);
  }, 180_000);

  it("moves a starter shop with Pending Orders to dedicated-1, verified, resuming after a worker crash, and serves it from there as plus", async () => {
    const { shop, products } = await starterShop("mv", ["Moving Lamp", "Moving Rug"]);
    shops.push(shop);
    await placeOrder(shop.handle, products[0]!, "approve");
    await placeOrder(shop.handle, products[1]!, "decline");
    // A buyer with a Cart open across the move.
    const buyer = new Browser(shop.handle);
    expect((await buyer.submit("/cart/items", { productId: products[1]!, action: "add" })).status).toBe(303);
    // Still Pending when the freeze starts (the slow payment takes 3 s).
    const pending = await placeOrder(shop.handle, products[0]!, "slow");
    expect((await ordersIn("pool-1", shop.id)).find((order) => order.id === pending)?.status).toBe("PENDING");

    const asked = await requestMove(shop.handle, "dedicated-1");
    expect(asked.status).toBe(202);
    expect(await asked.json()).toMatchObject({ status: "MOVING", from: "pool-1", to: "dedicated-1", planAfter: "plus" });
    expect((await requestMove(shop.handle, "dedicated-1")).status).toBe(409);

    // The worker is killed between the switch and the source's purge, and restarted.
    await waitUntil("the move switches", async () => (await stepsOf(shop.handle)).includes("move_switched"), 60_000, 100);
    compose("kill", "platform-worker");
    expect(await stepsOf(shop.handle)).not.toContain("move_source_purged");
    restartService("platform-worker");
    await expect.poll(() => stepsOf(shop.handle), { timeout: 90_000, interval: 500 }).toContain("move_source_purged");

    const events = await eventsOf(shop.handle);
    const verified = events.find((event) => event.step === "move_verified")!.detail.checksums as Record<string, { rows: number }>;
    const switched = events.find((event) => event.step === "move_switched")!;
    expect(switched.toStatus).toBe("ACTIVE");
    expect(switched.detail.frozenMs as number).toBeLessThan(30_000);

    // Every table's count and checksum in dedicated-1 is the source's; nothing is left in pool-1.
    expect(await shopChecksums("dedicated-1", shop.id)).toEqual(verified);
    expect(verified["catalog.products"]!.rows).toBe(2);
    expect(empty(await shopChecksums("pool-1", shop.id))).toBe(true);
    // The three Orders, once each, settled: the Pending one before the copy.
    const orders = await ordersIn("dedicated-1", shop.id);
    expect(orders).toHaveLength(3);
    expect(orders.find((order) => order.id === pending)?.status).toBe("CONFIRMED");
    expect(await tenantOf(shop.id)).toEqual({ cell: "dedicated-1", status: "ACTIVE", plan: "plus" });

    // Served from dedicated-1: the buyer's Cart is still there, and a new Order settles in dedicated-1.
    expect(await buyer.html("/cart")).toContain("Moving Rug");
    const placed = await placeOrder(shop.handle, products[0]!, "approve");
    await expect
      .poll(async () => (await ordersIn("dedicated-1", shop.id)).find((order) => order.id === placed)?.status, { timeout: 20_000, interval: 250 })
      .toBe("CONFIRMED");
    expect(await ordersIn("pool-1", shop.id)).toEqual([]);
  }, 240_000);

  it("refuses moves it cannot make", async () => {
    const [moved] = await platformQuery<Shop>("SELECT id, handle FROM platform.tenants WHERE cell = 'dedicated-1' AND status = 'ACTIVE' AND NOT internal");
    const cases: [string, string, number, string][] = [
      ["no-such-shop", "dedicated-1", 404, "tenant_not_found"],
      ["meadow", "nowhere-1", 409, "unknown_cell"],
      ["meadow", "pool-1", 409, "same_cell"],
      ["synthetic-pool-1", "dedicated-1", 409, "internal_shop"],
      // Only with dedicated-1 taken (by the shop moved above): otherwise the first would move Meadow.
      ...(moved
        ? ([
            ["meadow", "dedicated-1", 409, "no_capacity"],
            [moved.handle, "pool-1", 409, "plan_downgrade"],
          ] as [string, string, number, string][])
        : []),
    ];
    expect(moved, "the moved shop holds dedicated-1").toBeDefined();
    for (const [handle, cell, status, error] of cases) {
      const res = await requestMove(handle, cell);
      expect({ handle, cell, status: res.status, body: await res.json() }).toMatchObject({ status, body: { error } });
    }
    expect((await tenantOf("10000000-0000-4000-8000-000000000002"))?.status).toBe("ACTIVE");
  });
});
