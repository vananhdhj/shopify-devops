import { requiredEnv as required } from "@shop/service-kit";

export const config = {
  port: Number(process.env.PORT ?? 4002),
  databaseUrl: required("DATABASE_URL"),
  catalogApiUrl: required("CATALOG_API_URL"),
  orderTokenSecret: required("ORDER_TOKEN_SECRET"),
  adminServiceToken: required("ADMIN_SERVICE_TOKEN"),
  tenantContextSecret: required("TENANT_CONTEXT_SECRET"),
  platformCellToken: required("PLATFORM_CELL_TOKEN"),
  environment: process.env.APP_ENV ?? "dev",
  // The bad-release drill's fault: when "true", every Checkout fails with 500.
  // DRILL (Phase 4, ticket 07), reverted by the drill: a release that passes CI (Compose) but fails
  // wherever it is deployed, since only a Kubernetes pod has KUBERNETES_SERVICE_HOST. Waves must
  // stop it at the canary.
  checkoutFault: process.env.FAULT_CHECKOUT_ERRORS === "true" || process.env.KUBERNETES_SERVICE_HOST !== undefined,
};
