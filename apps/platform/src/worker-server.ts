import { Counter, Gauge, Histogram, Registry } from "prom-client";
import { createPool, createService, requiredEnv, runService } from "@shop/service-kit";
import { CellCredentials } from "@shop/tenancy";
import { type DeletionOutcome, deleteShop } from "./deletion.ts";
import { claimDue, type LifecycleEvent, retryLater } from "./lifecycle.ts";
import { type ExportOutcome, ExportStore, exportShop, forgetDeleted, scheduleExports } from "./exports.ts";
import { type MoveOutcome, moveShop } from "./move.ts";
import { type RestoreOutcome, restoreShop } from "./restore.ts";
import { type ProvisionOutcome, provision } from "./provision.ts";

const config = {
  opsPort: Number(process.env.OPS_PORT ?? 8102),
  databaseUrl: requiredEnv("DATABASE_URL"),
  environment: process.env.APP_ENV ?? "dev",
  pollIntervalMs: Number(process.env.LIFECYCLE_POLL_MS ?? 250),
  /** The edge, reached by Host like a buyer's browser, to check a shop once it is active. */
  router: { routerUrl: requiredEnv("EDGE_URL"), baseDomain: requiredEnv("TENANT_BASE_DOMAIN").toLowerCase() },
  /** Each cell's token for its purge and synthetic-catalog endpoints, one file per cell; the URLs come from the cell directory. */
  cellCredentialsDir: requiredEnv("CELL_CREDENTIALS_DIR"),
  /** Between a deletion's first purge and its verifying second one; longer than any settle job. */
  deleteGraceMs: Number(process.env.DELETE_GRACE_MS ?? 15_000),
  /** A tenant move (Phase 6): see MoveConfig. */
  move: {
    freezeGraceMs: Number(process.env.MOVE_FREEZE_GRACE_MS ?? 5_000),
    drainTimeoutMs: Number(process.env.MOVE_DRAIN_TIMEOUT_MS ?? 60_000),
    drainPollMs: Number(process.env.MOVE_DRAIN_POLL_MS ?? 500),
  },
  /**
   * Per-tenant exports (Phase 6, decision 3): the volume they are written to (none: no exports),
   * how often each ACTIVE shop is exported, and how many of its exports are kept.
   */
  exports: {
    dir: process.env.EXPORTS_DIR,
    intervalMs: Number(process.env.EXPORT_INTERVAL_MS ?? 15 * 60_000),
    keep: Number(process.env.EXPORT_KEEP ?? 8),
    scheduleMs: Number(process.env.EXPORT_SCHEDULE_MS ?? 60_000),
    /** Exports asked for per schedule tick, at most. */
    batch: Number(process.env.EXPORT_BATCH ?? 20),
  },
};

const db = createPool(config.databaseUrl);
const credentials = new CellCredentials(config.cellCredentialsDir);
const store = config.exports.dir ? new ExportStore(config.exports.dir) : undefined;
const registry = new Registry();
const completed = new Counter({
  name: "platform_lifecycle_completed_total",
  help: "Lifecycle events finished, by action",
  labelNames: ["action"] as const,
  registers: [registry],
});
const failures = new Counter({
  name: "platform_lifecycle_attempt_failures_total",
  help: "Lifecycle attempts that failed and were put back for a retry, by action",
  labelNames: ["action"] as const,
  registers: [registry],
});
const duration = new Histogram({
  name: "platform_lifecycle_seconds",
  help: "Time from a lifecycle request (signup, deletion, move) to its completion, by action",
  labelNames: ["action"] as const,
  buckets: [0.5, 1, 2, 3, 5, 10, 20, 30, 60, 120],
  registers: [registry],
});

const exportsTaken = new Counter({
  name: "platform_exports_total",
  help: "Per-tenant exports written to the export volume, by kind of request",
  labelNames: ["outcome"] as const,
  registers: [registry],
});
new Gauge({
  name: "platform_export_age_seconds",
  help: "Seconds since each ACTIVE shop's newest export (since its creation when it has none)",
  labelNames: ["tenant_id"] as const,
  registers: [registry],
  async collect() {
    const { rows } = await db.query<{ id: string; age: number }>(
      `SELECT t.id, extract(epoch FROM now() - coalesce(max(e.taken_at), t.created_at))::float8 AS age
         FROM platform.tenants t LEFT JOIN platform.tenant_exports e ON e.tenant_id = t.id
        WHERE t.status = 'ACTIVE' AND NOT t.internal GROUP BY t.id`,
    );
    this.reset();
    for (const row of rows) this.set({ tenant_id: row.id }, row.age);
  },
});

// Private operational listener: health and metrics only.
const ops = createService({ name: "platform-worker", environment: config.environment, db, registry });

function exportsVolume(): ExportStore {
  if (!store) throw new Error("no export volume (EXPORTS_DIR)");
  return store;
}

function run(event: LifecycleEvent): Promise<ProvisionOutcome | DeletionOutcome | MoveOutcome | ExportOutcome | RestoreOutcome> {
  switch (event.action) {
    case "provision":
      return provision(db, config.router, credentials, event);
    case "delete":
      return deleteShop(db, credentials, event, config.deleteGraceMs);
    case "move":
      return moveShop(db, credentials, event, config.move);
    case "export":
      return exportShop(db, credentials, exportsVolume(), event, config.exports.keep);
    case "restore":
      return restoreShop(db, credentials, exportsVolume(), event, config.move);
  }
}

let running = true;
async function loop(exports: boolean): Promise<void> {
  while (running) {
    try {
      for (const event of await claimDue(db, exports ? 1 : 10, exports)) {
        try {
          const outcome = await run(event);
          // A deletion's first pass ("verify_later") and a move waiting ("later") have neither
          // finished nor failed. An undone move has finished: the shop is back where it was.
          if (outcome === "retry") failures.inc({ action: event.action });
          if (outcome === "exported") exportsTaken.inc({ outcome });
          if (["active", "deleted", "moved", "undone", "exported", "restored", "nothing_to_do"].includes(outcome)) {
            completed.inc({ action: event.action });
            duration.observe({ action: event.action }, (Date.now() - event.createdAt.getTime()) / 1000);
          }
          ops.log.info({ tenantId: event.tenantId, action: event.action, attempt: event.attempts, outcome }, "lifecycle step");
        } catch (err) {
          failures.inc({ action: event.action });
          ops.log.warn({ err, tenantId: event.tenantId, action: event.action }, "lifecycle attempt failed; retrying");
          await retryLater(db, event).catch(() => {});
        }
      }
    } catch (err) {
      ops.log.warn({ err }, "lifecycle claim failed; retrying");
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}
void loop(false);
// Exports one at a time, beside the other lifecycle work.
void loop(true);

// Every ACTIVE shop is exported every EXPORT_INTERVAL: the scheduler asks for the exports that
// are due, and drops the exports of deleted shops.
async function scheduleLoop(): Promise<void> {
  while (running && store) {
    try {
      const asked = await scheduleExports(db, config.exports.intervalMs, config.exports.batch);
      const forgotten = await forgetDeleted(db, store);
      if (asked > 0 || forgotten > 0) ops.log.info({ asked, forgotten }, "exports scheduled");
    } catch (err) {
      ops.log.warn({ err }, "export scheduling failed; retrying");
    }
    await new Promise((resolve) => setTimeout(resolve, config.exports.scheduleMs));
  }
}
if (!store) ops.log.warn("no EXPORTS_DIR: shops are not exported, and restores fail");
void scheduleLoop();

await runService(ops, db, config.opsPort, async () => {
  running = false;
});
