import { requiredEnv as required } from "@shop/service-kit";

export const config = {
  port: Number(process.env.PORT ?? 4002),
  databaseUrl: required("DATABASE_URL"),
  catalogApiUrl: required("CATALOG_API_URL"),
  orderTokenSecret: required("ORDER_TOKEN_SECRET"),
  adminServiceToken: required("ADMIN_SERVICE_TOKEN"),
  // The cell's current secret, and during a rotation (Phase 7) the next one as well.
  tenantContextSecret: [required("TENANT_CONTEXT_SECRET"), process.env.TENANT_CONTEXT_SECRET_NEXT].filter((s): s is string => !!s),
  platformCellToken: required("PLATFORM_CELL_TOKEN"),
  environment: process.env.APP_ENV ?? "dev",
  // The bad-release drill's fault: when "true", every Checkout fails with 500.
  checkoutFault: process.env.FAULT_CHECKOUT_ERRORS === "true",
  /** Shop handles without a Checkout cap: none in the cluster; the Compose test stack's seeded shops. */
  checkoutLimitExempt: new Set((process.env.CHECKOUT_LIMIT_EXEMPT ?? "").split(",").filter(Boolean)),
};
