import Fastify, { type FastifyServerOptions } from "fastify";
import type { Pool } from "pg";
import type { ProductList } from "@shop/contracts";
import { registerMetrics } from "./metrics.ts";
import { findProduct, listProducts } from "./products.ts";
import { quietRoute } from "./routes.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}

export interface AppDeps {
  db: Pool;
}

export function buildApp(deps: AppDeps, options: FastifyServerOptions = {}) {
  const app = Fastify(options);
  registerMetrics(app);

  // Liveness says only that the process can answer; it must not depend on PostgreSQL,
  // or a database outage would turn into a restart storm.
  app.get("/health/live", quietRoute, async () => ({ status: "ok" }));

  app.get("/health/ready", quietRoute, async (_req, reply) => {
    try {
      await deps.db.query("SELECT 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.get("/products", async (): Promise<ProductList> => {
    return { products: await listProducts(deps.db) };
  });

  app.get<{ Params: { id: string } }>("/products/:id", async (req, reply) => {
    // A malformed id names no product, so it is a 404 rather than a database type error.
    const product = isUuid(req.params.id) ? await findProduct(deps.db, req.params.id) : undefined;
    if (!product) return reply.code(404).send({ error: "not_found", message: "product not found" });
    return product;
  });

  return app;
}
