import type { Pool } from "pg";
import { Counter, Gauge, Histogram, type Registry } from "prom-client";

/**
 * Buys from every cell's synthetic shop on a fixed interval, soak or not (Phase 5), so every cell
 * is measured even when its real shops are quiet. `SyntheticCheckoutFailing` reads the run of
 * failures; the soak gate keeps its own Checkouts (ADR-0024).
 */
export class SyntheticProber {
  private failuresInARow = new Map<string, number>();
  private readonly total: Counter<"cell" | "outcome">;
  private readonly seconds: Histogram<"cell">;
  private readonly consecutive: Gauge<"cell">;

  constructor(
    private db: Pool,
    private checkout: (handle: string) => Promise<boolean>,
    registry: Registry,
  ) {
    this.total = new Counter({
      name: "synthetic_checkout_total",
      help: "Synthetic Checkouts in each cell's synthetic shop, by outcome (passed: the Order left Pending)",
      labelNames: ["cell", "outcome"] as const,
      registers: [registry],
    });
    this.seconds = new Histogram({
      name: "synthetic_checkout_seconds",
      help: "Time from the synthetic shop's home page to its Order leaving Pending, by cell",
      labelNames: ["cell"] as const,
      buckets: [0.25, 0.5, 1, 2, 3, 5, 10, 20, 30],
      registers: [registry],
    });
    this.consecutive = new Gauge({
      name: "synthetic_checkout_consecutive_failures",
      help: "Synthetic Checkouts failed in a row in each cell (0 after a pass)",
      labelNames: ["cell"] as const,
      registers: [registry],
    });
  }

  /** One round: a Checkout in every cell's synthetic shop, side by side. */
  async round(): Promise<void> {
    const { rows } = await this.db.query<{ cell: string; handle: string }>(
      "SELECT cell, handle FROM platform.tenants WHERE internal AND status = 'ACTIVE' AND cell IS NOT NULL",
    );
    await Promise.all(
      rows.map(async ({ cell, handle }) => {
        const started = process.hrtime.bigint();
        const passed = await this.checkout(handle).catch(() => false);
        if (passed) this.seconds.observe({ cell }, Number(process.hrtime.bigint() - started) / 1e9);
        this.total.inc({ cell, outcome: passed ? "passed" : "failed" });
        const run = passed ? 0 : (this.failuresInARow.get(cell) ?? 0) + 1;
        this.failuresInARow.set(cell, run);
        this.consecutive.set({ cell }, run);
      }),
    );
  }
}
