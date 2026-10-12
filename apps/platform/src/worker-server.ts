import { Counter, Histogram, Registry } from "prom-client";
import { createPool, createService, requiredEnv, runService } from "@shop/service-kit";
import { CellCredentials } from "@shop/tenancy";
import { type DeletionOutcome, deleteShop } from "./deletion.ts";
import { claimDue, type LifecycleEvent, retryLater } from "./lifecycle.ts";
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
};

const db = createPool(config.databaseUrl);
const credentials = new CellCredentials(config.cellCredentialsDir);
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
  help: "Time from a lifecycle request (signup, deletion) to its completion, by action",
  labelNames: ["action"] as const,
  buckets: [0.5, 1, 2, 3, 5, 10, 20, 30, 60, 120],
  registers: [registry],
});

// Private operational listener: health and metrics only.
const ops = createService({ name: "platform-worker", environment: config.environment, db, registry });

function run(event: LifecycleEvent): Promise<ProvisionOutcome | DeletionOutcome> {
  switch (event.action) {
    case "provision":
      return provision(db, config.router, credentials, event);
    case "delete":
      return deleteShop(db, credentials, event, config.deleteGraceMs);
  }
}

let running = true;
async function loop(): Promise<void> {
  while (running) {
    try {
      for (const event of await claimDue(db)) {
        try {
          const outcome = await run(event);
          // A deletion's first pass ("verify_later") has neither finished nor failed.
          if (outcome === "retry") failures.inc({ action: event.action });
          if (outcome === "active" || outcome === "deleted" || outcome === "nothing_to_do") {
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
void loop();

await runService(ops, db, config.opsPort, async () => {
  running = false;
});
