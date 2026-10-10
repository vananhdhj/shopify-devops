import type { FastifyReply } from "fastify";
import type { Pool } from "pg";
import type { InventoryEffectRequest, InventoryEffectResult, ProductList } from "@shop/contracts";
import { createService, isUuid, secretsEqual, uuidPatternSource } from "@shop/service-kit";
import { createCart, getCart, setCartItemQuantity, type Missing } from "./carts.ts";
import { applyInventoryEffect } from "./inventory.ts";
import { findProduct, listProducts } from "./products.ts";

function notFound(reply: FastifyReply, missing: Missing) {
  return reply.code(404).send({ error: `${missing}_not_found`, message: `${missing} not found` });
}

const maxLineQuantity = 99;

const setQuantityBody = {
  type: "object",
  required: ["quantity"],
  properties: { quantity: { type: "integer", minimum: 0, maximum: maxLineQuantity } },
} as const;

const uuidString = { type: "string", pattern: uuidPatternSource } as const;

const inventoryEffectBody = {
  type: "object",
  required: ["orderId", "action", "items"],
  properties: {
    orderId: uuidString,
    action: { type: "string", enum: ["deduct", "release"] },
    items: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        required: ["productId", "quantity"],
        properties: { productId: uuidString, quantity: { type: "integer", minimum: 1, maximum: maxLineQuantity } },
      },
    },
  },
} as const;

export interface AppDeps {
  db: Pool;
  environment: string;
  /** Shared with the worker; the only credential that may change Stock. */
  internalInventoryToken: string;
}

export function buildApp(deps: AppDeps) {
  const app = createService({ name: "catalog-cart-api", environment: deps.environment, db: deps.db });

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

  // Internal: called by the worker only. Not reachable through ingress (only the storefront is
  // exposed), and refused without the internal service token.
  app.post<{ Body: InventoryEffectRequest }>(
    "/internal/inventory-effects",
    { schema: { body: inventoryEffectBody } },
    async (req, reply) => {
      if (!secretsEqual(req.headers["x-internal-token"], deps.internalInventoryToken)) {
        return reply.code(401).send({ error: "unauthorized", message: "internal token required" });
      }
      const { orderId, action, items } = req.body;
      const outcome = await applyInventoryEffect(deps.db, orderId.toLowerCase(), action, items);
      req.log.info({ orderId, action, outcome }, "inventory effect");
      const result: InventoryEffectResult = { orderId, action, outcome };
      return result;
    },
  );

  return app;
}
