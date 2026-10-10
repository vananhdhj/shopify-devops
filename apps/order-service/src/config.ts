import { requiredEnv as required } from "@shop/service-kit";

export const config = {
  port: Number(process.env.PORT ?? 4002),
  databaseUrl: required("DATABASE_URL"),
  catalogApiUrl: required("CATALOG_API_URL"),
  orderTokenSecret: required("ORDER_TOKEN_SECRET"),
  adminServiceToken: required("ADMIN_SERVICE_TOKEN"),
  environment: process.env.APP_ENV ?? "dev",
};
