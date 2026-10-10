import type { Pool } from "pg";
import type { JobCounter } from "./queue.ts";
import { Counter, Gauge, Registry } from "prom-client";
import type { Settlement } from "./settle.ts";

export interface WorkerMetrics {
  registry: Registry;
  settled: Counter<"outcome">;
  failures: Counter;
  exhausted: Counter;
  requeued: Counter;
}

/** Order-lifecycle metrics; queue depth and oldest Pending age are read fresh at scrape time. */
export function workerMetrics(db: Pool, queue: JobCounter): WorkerMetrics {
  const registry = new Registry();

  const settled = new Counter({
    name: "orders_settled_total",
    help: "Orders moved out of PENDING by this worker, by outcome",
    labelNames: ["outcome"] as const,
    registers: [registry],
  });
  const failures = new Counter({
    name: "worker_job_failures_total",
    help: "Failed job attempts; each is retried until attempts run out",
    registers: [registry],
  });
  const exhausted = new Counter({
    name: "worker_jobs_exhausted_total",
    help: "Settle jobs that used every attempt and were removed, leaving the Order to reconciliation",
    registers: [registry],
  });
  const requeued = new Counter({
    name: "outbox_events_requeued_total",
    help: "Reconciliation requeues of a stale Pending order's outbox event (one Order can count once per window)",
    registers: [registry],
  });
  new Gauge({
    name: "orders_queue_depth",
    help: "Settle-order jobs waiting, delayed, or active",
    registers: [registry],
    async collect() {
      const counts = await queue.getJobCounts("waiting", "delayed", "active");
      this.set((counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0));
    },
  });
  new Gauge({
    name: "orders_oldest_pending_age_seconds",
    help: "Age of the oldest Pending order, 0 when none",
    registers: [registry],
    async collect() {
      const { rows } = await db.query<{ age: number | null }>(
        "SELECT EXTRACT(EPOCH FROM now() - min(created_at))::float AS age FROM orders.orders WHERE status = 'PENDING'",
      );
      this.set(rows[0]?.age ?? 0);
    },
  });

  return { registry, settled, failures, exhausted, requeued };
}

export function recordSettlement(metrics: WorkerMetrics, settlement: Settlement): void {
  if (settlement !== "already_settled") metrics.settled.inc({ outcome: settlement });
}
