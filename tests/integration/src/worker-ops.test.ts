import { describe, expect, it } from "vitest";
import { waitFor } from "./http.ts";
import { effectsFor } from "./inventory.ts";
import { seedProducts } from "./seed.ts";
import { checkoutOf, readOrder, settled } from "./shopping.ts";
import { compose, restartService, workerMetrics } from "./stack.ts";

describe("worker operations", () => {
  it("exposes settled counts, queue depth, oldest Pending age, and failed attempts", async () => {
    const { orderId, orderToken } = await checkoutOf({ [seedProducts.notebookSet]: 1 }, "approve");
    await settled(orderId, orderToken);

    const metrics = workerMetrics();
    expect(metrics).toMatch(/^orders_settled_total\{outcome="confirmed"\} [1-9]/m);
    expect(metrics).toMatch(/^orders_queue_depth \d+/m);
    expect(metrics).toMatch(/^orders_oldest_pending_age_seconds [\d.]+/m);
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
