import type { Pool } from "pg";
import { Gauge, Registry } from "prom-client";

/**
 * Order metrics owned by the order service. The age of each tenant's oldest Pending order is read
 * from the database at scrape time, so it keeps rising (and the alert on it keeps working) even
 * while the worker that should settle those Orders is down. It spans every tenant in the cell, so
 * it reads through a narrow database function that returns only tenant ids and ages. A tenant
 * with no Pending order has no series; `max` over the cell is what the alert and the gate read.
 */
export function orderMetrics(db: Pool): Registry {
  const registry = new Registry();
  new Gauge({
    name: "orders_oldest_pending_age_seconds",
    help: "Age of each tenant's oldest Pending order (by tenant_id; absent when it has none)",
    labelNames: ["tenant_id"] as const,
    registers: [registry],
    async collect() {
      const { rows } = await db.query<{ tenant_id: string; age_seconds: number }>(
        "SELECT tenant_id, age_seconds FROM orders.oldest_pending_by_tenant()",
      );
      this.reset();
      for (const row of rows) this.set({ tenant_id: row.tenant_id }, row.age_seconds);
    },
  });
  return registry;
}
