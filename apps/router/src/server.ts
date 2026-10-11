import { Registry } from "prom-client";
import { createService, runService } from "@shop/service-kit";
import { buildApp } from "./app.ts";
import { config } from "./config.ts";

const registry = new Registry();
const proxy = buildApp({
  environment: config.environment,
  tenants: config.tenants,
  baseDomain: config.baseDomain,
  storefrontUrl: config.storefrontUrl,
  tenantContextSecret: config.tenantContextSecret,
  registry,
});

// Private operational listener: health and metrics only, never on the ingress. The tenant table is
// loaded before anything listens, so a running router is ready.
const ops = createService({ name: "router", environment: config.environment, registry, recordRequests: false });

await proxy.listen({ host: "0.0.0.0", port: config.port });
proxy.log.info({ tenants: config.tenants.map((tenant) => tenant.handle) }, "routing shops");

// On SIGTERM: readiness fails at once, then the proxy stops accepting and lets in-flight requests finish.
await runService(ops, undefined, config.opsPort, async () => {
  await proxy.close();
});
