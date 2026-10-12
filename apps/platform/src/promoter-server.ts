import { Counter, Gauge, Registry } from "prom-client";
import { createPool, createService, requiredEnv, runService } from "@shop/service-kit";
import { Promoter } from "./promoter.ts";
import { defaultLimits } from "./promotion-gate.ts";
import { cellMetrics, cellStates, dispatchPromotion, syntheticCheckout } from "./promoter-sources.ts";

// The promoter (Phase 4): soaks each release in its wave, checks the gate, and dispatches the
// promote workflow for the next wave, or halts. One replica; its state is in the registry.
const config = {
  opsPort: Number(process.env.OPS_PORT ?? 8103),
  databaseUrl: requiredEnv("DATABASE_URL"),
  environment: process.env.APP_ENV ?? "dev",
  tickMs: Number(process.env.PROMOTER_TICK_MS ?? 15_000),
  soakSeconds: Number(process.env.SOAK_SECONDS ?? 300),
  redispatchAfterSeconds: Number(process.env.REDISPATCH_AFTER_SECONDS ?? 600),
  argo: {
    apiUrl: process.env.KUBERNETES_API_URL ?? "https://kubernetes.default.svc",
    namespace: process.env.ARGOCD_NAMESPACE ?? "argocd",
    imagePrefix: requiredEnv("RELEASE_IMAGE_PREFIX"),
  },
  prometheusUrl: requiredEnv("PROMETHEUS_URL"),
  /** Synthetic Checkouts go through the edge by Host, as a guest's browser would. */
  edge: { edgeUrl: requiredEnv("EDGE_URL"), baseDomain: requiredEnv("TENANT_BASE_DOMAIN").toLowerCase() },
  github: {
    apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
    repository: requiredEnv("GITHUB_REPOSITORY"),
    /** Fine-grained, Actions: write on this repository only: it can start the promote workflow, nothing more. */
    token: requiredEnv("GITHUB_PROMOTE_TOKEN"),
  },
};

const db = createPool(config.databaseUrl);
const registry = new Registry();
const ops = createService({ name: "platform-promoter", environment: config.environment, db, registry });

const halted = new Gauge({
  name: "promotion_halted",
  help: "1 while the release a wave runs was halted by its gate (it resolves when the wave moves on: the revert)",
  labelNames: ["wave"] as const,
  registers: [registry],
});
const soaking = new Gauge({
  name: "promotion_soaking",
  help: "1 while a wave's release is soaking before promotion to the next wave",
  labelNames: ["wave"] as const,
  registers: [registry],
});
const checks = new Counter({
  name: "promotion_gate_checks_total",
  help: "Gate checks of soaking releases, by wave, cell, check, and outcome",
  labelNames: ["wave", "cell", "check", "outcome"] as const,
  registers: [registry],
});
const ticks = new Counter({
  name: "promoter_ticks_total",
  help: "Promoter ticks, by outcome (a failed tick is retried on the next)",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

const promoter = new Promoter({
  db,
  cells: () => cellStates(config.argo),
  metrics: (namespace) => cellMetrics(config.prometheusUrl, namespace),
  syntheticCheckout: (handle) => syntheticCheckout(config.edge, handle),
  dispatch: (wave, release, gate) => dispatchPromotion(config.github, wave, release, gate),
  soakSeconds: config.soakSeconds,
  limits: defaultLimits,
  redispatchAfterSeconds: config.redispatchAfterSeconds,
  log: ops.log,
});

let running = true;
async function loop(): Promise<void> {
  while (running) {
    try {
      const report = await promoter.tick();
      halted.reset();
      soaking.reset();
      for (const wave of report) {
        halted.set({ wave: String(wave.wave) }, wave.state === "halted" ? 1 : 0);
        soaking.set({ wave: String(wave.wave) }, wave.state === "soaking" ? 1 : 0);
        for (const check of wave.checks) checks.inc({ wave: String(wave.wave), ...check });
      }
      ticks.inc({ outcome: "ok" });
    } catch (err) {
      ticks.inc({ outcome: "failed" });
      ops.log.warn({ err }, "promoter tick failed; retrying");
    }
    await new Promise((resolve) => setTimeout(resolve, config.tickMs));
  }
}
void loop();

await runService(ops, db, config.opsPort, async () => {
  running = false;
});
