import { Queue, Worker } from "bullmq";
import { createPool, createService, runService } from "@shop/service-kit";
import { config } from "./config.ts";
import { dispatchOutbox } from "./dispatcher.ts";
import { inventoryClient } from "./inventory-client.ts";
import { recordSettlement, workerMetrics } from "./metrics.ts";
import { ordersQueue, redisConnection, type SettleOrderJob } from "./queue.ts";
import { settleOrder } from "./settle.ts";

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms).unref()),
  ]);
}

const db = createPool(config.databaseUrl);
const connection = redisConnection(config.redisUrl);
const queue = new Queue<SettleOrderJob>(ordersQueue, { connection });
const metrics = workerMetrics(db, queue);

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
    const settlement = await settleOrder(settleDeps, job.data.orderId);
    recordSettlement(metrics, settlement);
    ops.log.info({ orderId: job.data.orderId, settlement, attempt: job.attemptsMade + 1 }, "order settled");
    return settlement;
  },
  { connection, concurrency: config.concurrency, lockDuration: 10_000, stalledInterval: 5_000 },
);
worker.on("failed", (job, err) => {
  metrics.failures.inc();
  ops.log.warn({ orderId: job?.data.orderId, attempt: job?.attemptsMade, err }, "settle attempt failed");
});

let dispatching = true;
async function dispatchLoop(): Promise<void> {
  while (dispatching) {
    try {
      await dispatchOutbox(db, queue);
    } catch (err) {
      ops.log.warn({ err }, "outbox dispatch failed; retrying");
    }
    await new Promise((resolve) => setTimeout(resolve, config.dispatchIntervalMs));
  }
}
void dispatchLoop();

// On SIGTERM: stop dispatching and taking jobs, let active jobs finish, then close the rest.
await runService(ops, db, config.opsPort, async () => {
  dispatching = false;
  await worker.close();
  await queue.close();
});
