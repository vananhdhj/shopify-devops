import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "./http.ts";
import { effectsFor, inventoryEffect, reseed, stockOf } from "./inventory.ts";
import { asIdentity } from "./db.ts";
import { seedProducts } from "./seed.ts";
import { checkoutOf, readOrder, settled, statusChanges } from "./shopping.ts";
import { compose, metricValue, redisCli, restartService, workerMetrics } from "./stack.ts";

describe("reconciliation", () => {
  beforeAll(() => reseed());
  afterAll(() => {
    restartService("redis");
    restartService("worker");
  });

  it("accepts Checkouts while Redis is down and settles them all once it returns", async () => {
    // Seed Stock: Linen Apron 15.
    compose("stop", "redis");
    let orders: { orderId: string; orderToken: string }[];
    try {
      // Checkout never touches the queue: the outbox keeps accepted Orders durable in PostgreSQL.
      orders = await Promise.all(
        Array.from({ length: 5 }, () => checkoutOf({ [seedProducts.linenApron]: 1 }, "approve")),
      );
      // Give the worker time to try (and fail) to enqueue them: they must simply stay Pending.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      for (const { orderId, orderToken } of orders) {
        expect((await readOrder(orderId, orderToken)).body.status).toBe("PENDING");
      }
    } finally {
      restartService("redis");
    }

    const finals = await Promise.all(orders.map((o) => settled(o.orderId, o.orderToken, 60_000)));
    expect(finals.every((order) => order.status === "CONFIRMED")).toBe(true);
    expect(await stockOf(seedProducts.linenApron)).toBe(10);
    for (const { orderId } of orders) expect(await statusChanges(orderId)).toHaveLength(1);
  }, 120_000);

  it("recovers an Order whose queued job was lost after dispatch, deducting once", async () => {
    // Seed Stock: Brass Bottle Opener 35. `slow` holds the job for 3 s after the deduction.
    const { orderId, orderToken } = await checkoutOf({ [seedProducts.brassOpener]: 1 }, "slow");
    await waitFor(async () => (await effectsFor(orderId)).length === 1, "deduction recorded");

    // Crash the worker mid-job, then lose every queue entry: nothing in Redis knows the Order.
    compose("kill", "--signal", "SIGKILL", "worker");
    redisCli("FLUSHALL");
    restartService("worker");

    expect((await readOrder(orderId, orderToken)).body.status).toBe("PENDING");
    expect((await settled(orderId, orderToken, 60_000)).status).toBe("CONFIRMED");
    expect(await effectsFor(orderId)).toEqual([{ action: "deduct", outcome: "applied" }]);
    expect(await stockOf(seedProducts.brassOpener)).toBe(34);
    expect(await statusChanges(orderId)).toHaveLength(1);
  }, 120_000);

  it("settles an Order through reconciliation after its job used every attempt", async () => {
    compose("stop", "worker");
    // Seed Stock: Beeswax Candle 30. Deduct up front so only the release can fail.
    const { orderId, orderToken } = await checkoutOf({ [seedProducts.beeswaxCandle]: 3 }, "decline");
    await inventoryEffect({ orderId, action: "deduct", items: [{ productId: seedProducts.beeswaxCandle, quantity: 3 }] });

    await asIdentity("superuser", async (db) => {
      await db.query("BEGIN");
      await db.query("SELECT 1 FROM catalog.products WHERE id = $1 FOR UPDATE", [seedProducts.beeswaxCandle]);
      restartService("worker");
      // Wait until the job has spent its whole retry budget (set short for dev in compose.yaml)
      // and been removed: from here only reconciliation can bring the Order back to the queue.
      await waitFor(
        async () => metricValue(workerMetrics(), "worker_jobs_exhausted_total") >= 1,
        "settle job exhausted",
        60_000,
      );
      expect((await readOrder(orderId, orderToken)).body.status).toBe("PENDING");
      await db.query("ROLLBACK");
    });

    expect((await settled(orderId, orderToken, 60_000)).status).toBe("REJECTED_PAYMENT");
    expect(await stockOf(seedProducts.beeswaxCandle)).toBe(30);
    expect(await statusChanges(orderId)).toEqual([{ from_status: "PENDING", to_status: "REJECTED_PAYMENT" }]);
  }, 180_000);
});
