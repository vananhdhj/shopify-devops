import { describe, expect, it } from "vitest";
import { query } from "./db.ts";
import { waitFor } from "./http.ts";
import { effectsFor, stockOf } from "./inventory.ts";
import { seedProducts } from "./seed.ts";
import { checkoutOf, readOrder, settled } from "./shopping.ts";
import { compose, restartService, workerMetrics } from "./stack.ts";

describe("worker operations", () => {
  it("survives its database connections being cut mid-transaction, and still settles every Order", async () => {
    // Cut the order identity's connections again and again while Orders settle, as a database
    // restart or failover would. A connection cut while the worker holds it (inside a transaction,
    // or just as the pool hands it over) must fail that one attempt, to be retried, never crash
    // the process. Declined Orders deduct and then release their Stock, so it must end unchanged.
    const stockBefore = await stockOf(seedProducts.notebookSet);
    const orders = await Promise.all(Array.from({ length: 20 }, () => checkoutOf({ [seedProducts.notebookSet]: 1 }, "decline")));
    for (let cut = 0; cut < 40; cut++) {
      await query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'order_app' AND pid <> pg_backend_pid()");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(compose("ps", "--format", "{{.State}}", "worker").trim()).toBe("running");
    for (const { orderId, orderToken } of orders) {
      expect.soft((await settled(orderId, orderToken, 30_000)).status, orderId).toBe("REJECTED_PAYMENT");
    }
    expect(await stockOf(seedProducts.notebookSet)).toBe(stockBefore);
  });

  it("exposes settled counts, queue depth, and failed attempts", async () => {
    const { orderId, orderToken } = await checkoutOf({ [seedProducts.notebookSet]: 1 }, "approve");
    await settled(orderId, orderToken);

    const metrics = workerMetrics();
    expect(metrics).toMatch(/^orders_settled_total\{outcome="confirmed"\} [1-9]/m);
    expect(metrics).toMatch(/^orders_queue_depth \d+/m);
    expect(metrics).toMatch(/^worker_job_failures_total \d+/m);
  });

  it("finishes the job in hand before exiting cleanly on SIGTERM", async () => {
    // `slow` holds the job for 3 s after the deduction; SIGTERM arrives inside that window.
    const { orderId, orderToken } = await checkoutOf({ [seedProducts.notebookSet]: 1 }, "slow");
    await waitFor(async () => (await effectsFor(orderId)).length === 1, "deduction recorded");

    try {
      compose("stop", "--timeout", "10", "worker");
      expect(compose("ps", "--all", "--format", "{{.ExitCode}}", "worker").trim()).toBe("0");
      expect((await readOrder(orderId, orderToken)).body.status).toBe("CONFIRMED");
    } finally {
      restartService("worker");
    }
  }, 60_000);
});
