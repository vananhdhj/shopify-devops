import type { FastifyReply } from "fastify";
import type { Pool } from "pg";
import type { ProductList } from "@shop/contracts";
import { createService, isUuid } from "@shop/service-kit";
import { createCart, getCart, setCartItemQuantity, type Missing } from "./carts.ts";
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

export interface AppDeps {
  db: Pool;
  environment: string;
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

  return app;
}
