import { Registry } from "prom-client";
import { createService, runService } from "@shop/service-kit";
import { buildApp } from "./app.ts";
import { config } from "./config.ts";
import { registryRoutes, staticRoutes, type RouteSource } from "./routes.ts";

const registry = new Registry();
// Private operational listener: health and metrics only, never on the ingress. The router is ready
// once it has a routing table, and stays ready on its cached table while the control plane is down.
let routes: RouteSource | undefined;
const ops = createService({
  name: "router",
  environment: config.environment,
  registry,
  recordRequests: false,
  readinessChecks: [
    async () => {
      if (!routes?.ready()) throw new Error("no routing table yet");
    },
  ],
});

const registryMode = config.registry
  ? registryRoutes({
      platformApiUrl: config.registry.platformApiUrl,
      routerToken: config.registry.routerToken,
      refreshMs: config.registry.routesRefreshMs,
      registry,
      log: ops.log,
    })
  : undefined;
routes = registryMode ?? staticRoutes(config.staticTenants ?? []);

const proxy = buildApp({
  environment: config.environment,
  routes,
  baseDomain: config.baseDomain,
  storefrontUrl: config.storefrontUrl,
  tenantContextSecret: config.tenantContextSecret,
  registry,
});

await proxy.listen({ host: "0.0.0.0", port: config.port });
await registryMode?.start();
proxy.log.info({ mode: registryMode ? "registry" : "static", ready: routes.ready() }, "routing shops");

// On SIGTERM: readiness fails at once, then the proxy stops accepting and lets in-flight requests finish.
await runService(ops, undefined, config.opsPort, async () => {
  registryMode?.stop();
  await proxy.close();
});
