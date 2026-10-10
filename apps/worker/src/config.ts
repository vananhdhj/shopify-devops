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
  /** Quick retries per settle job before it is removed and left to reconciliation. */
  settleRetry: {
    attempts: Number(process.env.SETTLE_ATTEMPTS ?? 10),
    backoffMs: Number(process.env.SETTLE_BACKOFF_MS ?? 500),
  },
  reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS ?? 10_000),
  /** How long a Pending order's dispatched event may go unsettled before it is re-enqueued. */
  reconcileStaleAfterMs: Number(process.env.RECONCILE_STALE_AFTER_MS ?? 30_000),
};
