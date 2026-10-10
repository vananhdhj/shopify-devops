import type { Pool } from "pg";
import { Gauge, Registry } from "prom-client";

/**
 * Order metrics owned by the order service. The age of the oldest Pending order is read from the
 * database at scrape time, so it keeps rising (and the alert on it keeps working) even while the
 * worker that should settle those Orders is down.
 */
export function orderMetrics(db: Pool): Registry {
  const registry = new Registry();
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
  return registry;
}
