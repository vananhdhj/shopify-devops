import { requiredEnv as required } from "@shop/service-kit";

export const config = {
  opsPort: Number(process.env.OPS_PORT ?? 4003),
  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),
  catalogApiUrl: required("CATALOG_API_URL"),
  internalInventoryToken: required("INTERNAL_INVENTORY_TOKEN"),
  environment: process.env.APP_ENV ?? "dev",
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),
  slowPaymentDelayMs: Number(process.env.SLOW_PAYMENT_DELAY_MS ?? 3_000),
  dispatchIntervalMs: Number(process.env.DISPATCH_INTERVAL_MS ?? 250),
};
