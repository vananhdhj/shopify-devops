import { requiredEnv as required } from "@shop/service-kit";

export const config = {
  port: Number(process.env.PORT ?? 4001),
  databaseUrl: required("DATABASE_URL"),
  environment: process.env.APP_ENV ?? "dev",
  internalInventoryToken: required("INTERNAL_INVENTORY_TOKEN"),
};
