import Fastify, { type FastifyError, type FastifyReply, type FastifyServerOptions } from "fastify";
import type { Pool } from "pg";
import type { ProductList } from "@shop/contracts";
import { createCart, getCart, setCartItemQuantity, type Missing } from "./carts.ts";
import { registerMetrics } from "./metrics.ts";
import { findProduct, listProducts } from "./products.ts";
import { quietRoute } from "./routes.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}

function notFound(reply: FastifyReply, missing: Missing) {
  return reply.code(404).send({ error: `${missing}_not_found`, message: `${missing} not found` });
}

const maxLineQuantity = 99;

const setQuantityBody = {
  type: "object",
  required: ["quantity"],
  properties: { quantity: { type: "integer", minimum: 0, maximum: maxLineQuantity } },
} as const;

export interface AppDeps {
  db: Pool;
}

export function buildApp(deps: AppDeps, options: FastifyServerOptions = {}) {
  // No type coercion: a quantity sent as "2" is a client error, not a number.
  const app = Fastify({ ...options, ajv: { customOptions: { coerceTypes: false } } });
  registerMetrics(app);

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status < 500) {
      return reply.code(status).send({ error: "invalid_request", message: err.message });
    }
    req.log.error({ err }, "request failed");
    return reply.code(500).send({ error: "internal_error", message: "internal error" });
  });

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
    if (!product) return notFound(reply, "product");
    return product;
  });

  app.post("/carts", async (_req, reply) => {
    return reply.code(201).send(await createCart(deps.db));
  });

  app.get<{ Params: { id: string } }>("/carts/:id", async (req, reply) => {
    const cart = isUuid(req.params.id) ? await getCart(deps.db, req.params.id) : undefined;
    if (!cart) return notFound(reply, "cart");
    return cart;
  });

  app.put<{ Params: { id: string; productId: string }; Body: { quantity: number } }>(
    "/carts/:id/items/:productId",
    { schema: { body: setQuantityBody } },
    async (req, reply) => {
      const { id, productId } = req.params;
      if (!isUuid(id)) return notFound(reply, "cart");
      if (!isUuid(productId)) return notFound(reply, "product");

      const result = await setCartItemQuantity(deps.db, id, productId, req.body.quantity);
      return result.outcome === "updated" ? result.cart : notFound(reply, result.missing);
    },
  );

  return app;
}
