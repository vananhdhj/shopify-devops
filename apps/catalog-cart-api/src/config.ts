import { requiredEnv as required } from "@shop/service-kit";

export const config = {
  port: Number(process.env.PORT ?? 4001),
  databaseUrl: required("DATABASE_URL"),
  environment: process.env.APP_ENV ?? "dev",
  internalInventoryToken: required("INTERNAL_INVENTORY_TOKEN"),
  adminServiceToken: required("ADMIN_SERVICE_TOKEN"),
  tenantContextSecret: required("TENANT_CONTEXT_SECRET"),
  platformCellToken: required("PLATFORM_CELL_TOKEN"),
  /** Shop handles without a product quota: none in the cluster; the Compose test stack's seeded shops. */
  productQuotaExempt: new Set((process.env.PRODUCT_QUOTA_EXEMPT ?? "").split(",").filter(Boolean)),
};
