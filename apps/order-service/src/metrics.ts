import type { Pool } from "pg";
import { Gauge, Registry } from "prom-client";

/**
 * Order metrics owned by the order service. The age of the oldest Pending order is read from the
 * database at scrape time, so it keeps rising (and the alert on it keeps working) even while the
 * worker that should settle those Orders is down. It spans every tenant in the cell, so it reads
 * through a narrow database function that returns only the age.
 */
export function orderMetrics(db: Pool): Registry {
  const registry = new Registry();
  new Gauge({
    name: "orders_oldest_pending_age_seconds",
    help: "Age of the oldest Pending order, 0 when none",
    registers: [registry],
    async collect() {
      const { rows } = await db.query<{ age: number | null }>("SELECT orders.oldest_pending_age_seconds() AS age");
      this.set(rows[0]?.age ?? 0);
    },
  });
  return registry;
}
