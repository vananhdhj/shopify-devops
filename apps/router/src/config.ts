import { readFileSync } from "node:fs";
import { requiredEnv as required } from "@shop/service-kit";
import { parseTenantTable } from "@shop/tenancy";

export const config = {
  port: Number(process.env.PORT ?? 8000),
  /** Private listener for health and metrics: the public port is on the ingress. */
  opsPort: Number(process.env.OPS_PORT ?? 8001),
  environment: process.env.APP_ENV ?? "dev",
  storefrontUrl: required("STOREFRONT_URL"),
  /** Shops live at `<handle>.<baseDomain>`. */
  baseDomain: required("TENANT_BASE_DOMAIN").toLowerCase(),
  tenantContextSecret: required("TENANT_CONTEXT_SECRET"),
  // Read once at startup: a missing or invalid table stops the router before it serves anything.
  tenants: parseTenantTable(readFileSync(required("TENANTS_FILE"), "utf8")),
};
