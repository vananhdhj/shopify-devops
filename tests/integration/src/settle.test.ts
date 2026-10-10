import { beforeAll, describe, expect, it } from "vitest";
import { query } from "./db.ts";
import { effectsFor, reseed, stockOf } from "./inventory.ts";
import { seedProducts } from "./seed.ts";
import { checkoutOf, settled, statusChanges } from "./shopping.ts";

describe("worker settles orders", () => {
  beforeAll(() => reseed());

  it("confirms an approved Order, deducting its Stock once and recording one status change", async () => {
    // Seed Stock: Linen Apron 15.
    const { orderId, orderToken } = await checkoutOf({ [seedProducts.linenApron]: 2 }, "approve");

    expect((await settled(orderId, orderToken)).status).toBe("CONFIRMED");
    expect(await stockOf(seedProducts.linenApron)).toBe(13);
    expect(await statusChanges(orderId)).toEqual([{ from_status: "PENDING", to_status: "CONFIRMED" }]);
  });

  it("rejects a declined Order after returning the Stock it took", async () => {
    // Seed Stock: Beeswax Candle 30.
    const { orderId, orderToken } = await checkoutOf({ [seedProducts.beeswaxCandle]: 4 }, "decline");

    expect((await settled(orderId, orderToken)).status).toBe("REJECTED_PAYMENT");
    expect(await stockOf(seedProducts.beeswaxCandle)).toBe(30);
    expect(await effectsFor(orderId)).toEqual([
      { action: "deduct", outcome: "applied" },
      { action: "release", outcome: "applied" },
    ]);
    expect(await statusChanges(orderId)).toEqual([{ from_status: "PENDING", to_status: "REJECTED_PAYMENT" }]);
  });

  it("confirms a slow Order only after the payment delay", async () => {
    // Seed Stock: Brass Bottle Opener 35. The worker's slow-payment delay is 3 seconds.
    const { orderId, orderToken } = await checkoutOf({ [seedProducts.brassOpener]: 1 }, "slow");

    expect((await settled(orderId, orderToken)).status).toBe("CONFIRMED");
    const [timing] = await query<{ seconds: number }>(
      `SELECT EXTRACT(EPOCH FROM e.created_at - o.created_at)::float AS seconds
         FROM orders.order_events e JOIN orders.orders o ON o.id = e.order_id WHERE e.order_id = $1`,
      [orderId],
    );
    expect(timing!.seconds).toBeGreaterThanOrEqual(3);
    expect(await stockOf(seedProducts.brassOpener)).toBe(34);
  });

  it("rejects an Order whose Stock ran out without deducting any line", async () => {
    // Seed Stock: Cotton Throw 6, Olive Wood Board 8.
    const { orderId, orderToken } = await checkoutOf(
      { [seedProducts.oliveWoodBoard]: 1, [seedProducts.cottonThrow]: 7 },
      "approve",
    );

    expect((await settled(orderId, orderToken)).status).toBe("REJECTED_OUT_OF_STOCK");
    expect(await stockOf(seedProducts.oliveWoodBoard)).toBe(8);
    expect(await stockOf(seedProducts.cottonThrow)).toBe(6);
    expect(await statusChanges(orderId)).toEqual([{ from_status: "PENDING", to_status: "REJECTED_OUT_OF_STOCK" }]);
  });
});
