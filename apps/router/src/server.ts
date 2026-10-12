import { Registry } from "prom-client";
import { createService, runService } from "@shop/service-kit";
import { CellCredentials } from "@shop/tenancy";
import { buildApp } from "./app.ts";
import { config } from "./config.ts";
import { registryRoutes, type RouteSource } from "./routes.ts";
import { cellUpstreams, singleCellUpstream } from "./upstreams.ts";

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

const registryRouteSource = registryRoutes({
  platformApiUrl: config.platformApiUrl,
  routerToken: config.routerToken,
  refreshMs: config.routesRefreshMs,
  cacheFile: config.routesCacheFile,
  registry,
  log: ops.log,
});
routes = registryRouteSource;

const proxy = buildApp({
  environment: config.environment,
  routes,
  baseDomain: config.baseDomain,
  upstreamFor: config.singleCell
    ? singleCellUpstream(config.singleCell.cell, config.singleCell.storefrontUrl, config.singleCell.tenantContextSecret)
    : cellUpstreams(routes, new CellCredentials(config.cellCredentialsDir!)),
  platformPublicUrl: config.platformPublicUrl,
  registry,
});

await proxy.listen({ host: "0.0.0.0", port: config.port });
await registryRouteSource.start();
proxy.log.info(
  { ready: routes.ready(), mode: config.singleCell ? `single cell ${config.singleCell.cell}` : "edge, every cell" },
  "routing shops from the control plane",
);

// On SIGTERM: readiness fails at once, then the proxy stops accepting and lets in-flight requests finish.
await runService(ops, undefined, config.opsPort, async () => {
  registryRouteSource.stop();
  await proxy.close();
});
