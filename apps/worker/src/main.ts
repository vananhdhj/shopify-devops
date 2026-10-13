import { Queue, Worker } from "bullmq";
import { createPool, createService, runService } from "@shop/service-kit";
import { config } from "./config.ts";
import { dispatchOutbox } from "./dispatcher.ts";
import { inventoryClient } from "./inventory-client.ts";
import { recordSettlement, workerMetrics } from "./metrics.ts";
import { ordersQueue, redisConnection, type SettleOrderJob } from "./queue.ts";
import { reconcileStalePending } from "./reconcile.ts";
import { settleOrder } from "./settle.ts";
import { withTimeout } from "./timeout.ts";

const db = createPool(config.databaseUrl);
const connection = redisConnection(config.redisUrl);
// The producer side fails fast while Redis is unreachable instead of buffering commands in
// memory: during a long outage the dispatcher would otherwise pile up abandoned enqueues.
const queue = new Queue<SettleOrderJob>(ordersQueue, { connection: { ...connection, enableOfflineQueue: false } });
const metrics = workerMetrics(queue);

// Private operational listener: health and metrics only, no business endpoints.
const ops = createService({
  name: "worker",
  environment: config.environment,
  db,
  registry: metrics.registry,
  // Redis commands wait for a reconnect rather than fail, so bound the probe explicitly.
  readinessChecks: [() => withTimeout(queue.getJobCounts("waiting"), 2_000, "redis unreachable")],
});

const settleDeps = {
  db,
  inventory: inventoryClient(config.catalogApiUrl, config.internalInventoryToken),
  slowPaymentDelayMs: config.slowPaymentDelayMs,
};

// A job is acknowledged only when settleOrder returns; a crash or a thrown error leaves it to be
// retried (stalled jobs are reclaimed after the lock lapses).
const worker = new Worker<SettleOrderJob>(
  ordersQueue,
  async (job) => {
    const { tenantId, orderId } = job.data;
    const settlement = await settleOrder(settleDeps, tenantId, orderId);
    recordSettlement(metrics, tenantId, settlement);
    ops.log.info({ tenantId, orderId, settlement, attempt: job.attemptsMade + 1 }, "order settled");
    return settlement;
  },
  { connection, concurrency: config.concurrency, lockDuration: 10_000, stalledInterval: 5_000 },
);
worker.on("failed", (job, err) => {
  metrics.failures.inc();
  ops.log.warn({ tenantId: job?.data.tenantId, orderId: job?.data.orderId, attempt: job?.attemptsMade, err }, "settle attempt failed");
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    metrics.exhausted.inc();
    ops.log.warn({ tenantId: job.data.tenantId, orderId: job.data.orderId }, "settle attempts exhausted; left to reconciliation");
  }
});

let running = true;
/** Runs `step` every `intervalMs` until shutdown, logging (not throwing) failures. */
async function every(intervalMs: number, taskName: string, step: () => Promise<void>): Promise<void> {
  while (running) {
    try {
      await step();
    } catch (err) {
      ops.log.warn({ err }, `${taskName} failed; retrying`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

void every(config.dispatchIntervalMs, "outbox dispatch", async () => {
  await dispatchOutbox(db, queue, config.settleRetry, config.dispatchPerTenant);
});
void every(config.reconcileIntervalMs, "reconciliation", async () => {
  const requeued = await reconcileStalePending(db, config.reconcileStaleAfterMs);
  if (requeued > 0) {
    metrics.requeued.inc(requeued);
    ops.log.info({ requeued }, "requeueing stale Pending orders");
  }
});

// On SIGTERM: stop dispatching and taking jobs, let active jobs finish, then close the rest.
await runService(ops, db, config.opsPort, async () => {
  running = false;
  await worker.close();
  await queue.close();
});
