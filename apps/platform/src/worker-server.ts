import { Counter, Histogram, Registry } from "prom-client";
import { createPool, createService, requiredEnv, runService } from "@shop/service-kit";
import { claimDue, type LifecycleEvent, retryLater } from "./lifecycle.ts";
import { type ProvisionOutcome, provision } from "./provision.ts";

const config = {
  opsPort: Number(process.env.OPS_PORT ?? 8102),
  databaseUrl: requiredEnv("DATABASE_URL"),
  environment: process.env.APP_ENV ?? "dev",
  pollIntervalMs: Number(process.env.LIFECYCLE_POLL_MS ?? 250),
  /** The cell's router, reached by Host like a buyer's browser, to check a shop once it is active. */
  router: { routerUrl: requiredEnv("CELL_ROUTER_URL"), baseDomain: requiredEnv("TENANT_BASE_DOMAIN").toLowerCase() },
};

const db = createPool(config.databaseUrl);
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

function run(event: LifecycleEvent): Promise<ProvisionOutcome> {
  switch (event.action) {
    case "provision":
      return provision(db, config.router, event);
    case "delete":
      throw new Error("deletion is not implemented yet"); // ticket 04
  }
}

let running = true;
async function loop(): Promise<void> {
  while (running) {
    try {
      for (const event of await claimDue(db)) {
        try {
          const outcome = await run(event);
          if (outcome === "retry") failures.inc({ action: event.action });
          if (outcome === "active" || outcome === "nothing_to_do") {
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
