import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asIdentity } from "./db.ts";
import { waitFor } from "./http.ts";
import { effectsFor, inventoryEffect, reseed, stockOf } from "./inventory.ts";
import { seedProducts } from "./seed.ts";
import { checkoutOf, readOrder, settled, statusChanges } from "./shopping.ts";
import { compose, metricValue, restartService, scaleService, workerMetrics } from "./stack.ts";

/** How many Orders each worker replica settled since `since`, keyed by replica name. */
function settledPerReplica(since: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of compose("logs", "--since", since, "worker").split("\n")) {
    const match = line.match(/^(worker-\d+)\s+\|.*"order settled"/);
    if (match) counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
  }
  return counts;
}

describe("worker resilience", () => {
  beforeAll(() => reseed());
  afterAll(() => scaleService("worker", 1));

  it("confirms exactly one of 20 concurrent Orders for the last unit, never going below zero", async () => {
    // Seed Stock: Final Print 1.
    const orders = await Promise.all(
      Array.from({ length: 20 }, () => checkoutOf({ [seedProducts.finalPrint]: 1 }, "approve")),
    );

    const finals = await Promise.all(orders.map((o) => settled(o.orderId, o.orderToken, 40_000)));
    const statuses = finals.map((order) => order.status);

    expect(statuses.filter((s) => s === "CONFIRMED")).toHaveLength(1);
    expect(statuses.filter((s) => s === "REJECTED_OUT_OF_STOCK")).toHaveLength(19);
    expect(await stockOf(seedProducts.finalPrint)).toBe(0);
  }, 60_000);

  it("settles every Order once with two worker replicas sharing the queue", async () => {
    scaleService("worker", 2);
    const since = new Date().toISOString();
    // Seed Stock: Canvas Tote 40.
    const orders = await Promise.all(
      Array.from({ length: 30 }, () => checkoutOf({ [seedProducts.canvasTote]: 1 }, "approve")),
    );

    const finals = await Promise.all(orders.map((o) => settled(o.orderId, o.orderToken, 40_000)));

    expect(finals.every((order) => order.status === "CONFIRMED")).toBe(true);
    expect(await stockOf(seedProducts.canvasTote)).toBe(10);
    for (const { orderId } of orders) {
      expect(await effectsFor(orderId)).toEqual([{ action: "deduct", outcome: "applied" }]);
      expect(await statusChanges(orderId)).toHaveLength(1);
    }
    // Both replicas really took jobs, so the once-only results above were tested under competition.
    const perReplica = settledPerReplica(since);
    expect(perReplica.size).toBe(2);
    expect([...perReplica.values()].reduce((sum, n) => sum + n, 0)).toBeGreaterThanOrEqual(30);
  }, 90_000);

  it("deducts once when the worker is killed between the deduction and the status change", async () => {
    scaleService("worker", 1);
    // Seed Stock: Ceramic Planter 12. `slow` pauses 3 s after deducting, before confirming.
    const { orderId, orderToken } = await checkoutOf({ [seedProducts.ceramicPlanter]: 1 }, "slow");
    await waitFor(async () => (await effectsFor(orderId)).length === 1, "deduction recorded");

    compose("kill", "--signal", "SIGKILL", "worker");
    expect((await readOrder(orderId, orderToken)).body.status).toBe("PENDING");
    restartService("worker");

    expect((await settled(orderId, orderToken, 40_000)).status).toBe("CONFIRMED");
    expect(await effectsFor(orderId)).toEqual([{ action: "deduct", outcome: "applied" }]);
    expect(await stockOf(seedProducts.ceramicPlanter)).toBe(11);
    expect(await statusChanges(orderId)).toHaveLength(1);
  }, 90_000);

  it("keeps a declined Order Pending, retrying, while its Stock cannot be released", async () => {
    compose("stop", "worker");
    try {
      // Seed Stock: Beeswax Candle 30.
      const { orderId, orderToken } = await checkoutOf({ [seedProducts.beeswaxCandle]: 2 }, "decline");
      // Apply the deduction now, as the worker would, so only the release is left to fail.
      await inventoryEffect({ orderId, action: "deduct", items: [{ productId: seedProducts.beeswaxCandle, quantity: 2 }] });
      expect(await stockOf(seedProducts.beeswaxCandle)).toBe(28);

      await asIdentity("superuser", async (db) => {
        await db.query("BEGIN");
        // Hold the product row so every release attempt times out.
        await db.query("SELECT 1 FROM catalog.products WHERE id = $1 FOR UPDATE", [seedProducts.beeswaxCandle]);
        restartService("worker");
        await new Promise((resolve) => setTimeout(resolve, 8_000));
        expect((await readOrder(orderId, orderToken)).body.status).toBe("PENDING");
        // The freshly started worker has already failed and retried at least once.
        expect(metricValue(workerMetrics(), "worker_job_failures_total")).toBeGreaterThanOrEqual(1);
        await db.query("ROLLBACK");
      });

      expect((await settled(orderId, orderToken, 40_000)).status).toBe("REJECTED_PAYMENT");
      expect(await stockOf(seedProducts.beeswaxCandle)).toBe(30);
      expect(await statusChanges(orderId)).toEqual([{ from_status: "PENDING", to_status: "REJECTED_PAYMENT" }]);
    } finally {
      restartService("worker");
    }
  }, 90_000);
});
