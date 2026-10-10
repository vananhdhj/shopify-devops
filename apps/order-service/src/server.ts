import { createPool, runService } from "@shop/service-kit";
import { buildApp } from "./app.ts";
import { config } from "./config.ts";

const db = createPool(config.databaseUrl);
const app = buildApp({
  db,
  environment: config.environment,
  catalogApiUrl: config.catalogApiUrl,
  orderTokenSecret: config.orderTokenSecret,
  adminServiceToken: config.adminServiceToken,
  checkoutFault: config.checkoutFault,
});
await runService(app, db, config.port);
