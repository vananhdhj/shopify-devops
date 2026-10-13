import type { JobCounter } from "./queue.ts";
import { Counter, Gauge, Registry } from "prom-client";
import type { Settlement } from "./settle.ts";

export interface WorkerMetrics {
  registry: Registry;
  settled: Counter<"tenant_id" | "outcome">;
  failures: Counter;
  exhausted: Counter;
  requeued: Counter;
}

/** Settlement metrics; queue depth is read fresh at scrape time. (Oldest Pending age is the order service's.) */
export function workerMetrics(queue: JobCounter): WorkerMetrics {
  const registry = new Registry();

  const settled = new Counter({
    name: "orders_settled_total",
    help: "Orders moved out of PENDING by this worker, by tenant and outcome",
    labelNames: ["tenant_id", "outcome"] as const,
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

  return { registry, settled, failures, exhausted, requeued };
}

export function recordSettlement(metrics: WorkerMetrics, tenantId: string, settlement: Settlement): void {
  if (settlement !== "already_settled") metrics.settled.inc({ tenant_id: tenantId, outcome: settlement });
}
