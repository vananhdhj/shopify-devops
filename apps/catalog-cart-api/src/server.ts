import { createPool, runService, startTracing } from "@shop/service-kit";
import { buildApp } from "./app.ts";
import { config } from "./config.ts";

startTracing("catalog-cart-api", config.environment);
const db = createPool(config.databaseUrl);
const app = buildApp({
  db,
  environment: config.environment,
  internalInventoryToken: config.internalInventoryToken,
  adminServiceToken: config.adminServiceToken,
  tenantContextSecret: config.tenantContextSecret,
  platformCellToken: config.platformCellToken,
  productQuotaExempt: config.productQuotaExempt,
});
await runService(app, db, config.port);
