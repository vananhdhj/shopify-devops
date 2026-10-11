import { createPool, runService } from "@shop/service-kit";
import { config } from "./config.ts";
import { buildInternalApp } from "./internal-app.ts";

const db = createPool(config.databaseUrl);
const internal = buildInternalApp({
  db,
  environment: config.environment,
  routerToken: config.routerToken,
  storefrontToken: config.storefrontToken,
});
await runService(internal, db, config.internalPort);
