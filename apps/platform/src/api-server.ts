import { Registry } from "prom-client";
import { createPool, runService } from "@shop/service-kit";
import { config } from "./config.ts";
import { buildInternalApp } from "./internal-app.ts";
import { buildPublicApp } from "./public-app.ts";

const db = createPool(config.databaseUrl);
const registry = new Registry();
const internal = buildInternalApp({
  db,
  environment: config.environment,
  routerToken: config.routerToken,
  storefrontToken: config.storefrontToken,
  operatorToken: config.operatorToken,
  registry,
});
const publicApp = buildPublicApp({ db, environment: config.environment, baseDomain: config.baseDomain, registry });

await publicApp.listen({ host: "0.0.0.0", port: config.publicPort });
// The internal listener owns health, metrics, and shutdown: SIGTERM fails readiness, closes the
// public listener after its in-flight signups, then drains itself.
await runService(internal, db, config.internalPort, async () => {
  await publicApp.close();
});
