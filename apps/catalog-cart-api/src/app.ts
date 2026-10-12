import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import type { InventoryEffectRequest, InventoryEffectResult, NewProduct, ProductList } from "@shop/contracts";
import {
  createService,
  isUuid,
  requireSecretHeader,
  tenantOf,
  uuidPatternSource,
  withTenant,
  withoutTenant,
} from "@shop/service-kit";
import { createCart, getCart, setCartItemQuantity, type Missing } from "./carts.ts";
import { applyInventoryEffect } from "./inventory.ts";
import { addProduct, findProduct, listProducts } from "./products.ts";

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
  required: ["tenantId", "orderId", "action", "items"],
  properties: {
    tenantId: uuidString,
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

const newProductBody = {
  type: "object",
  required: ["name", "priceMinor", "stock"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", maxLength: 2_000 },
    priceMinor: { type: "integer", minimum: 0 },
    stock: { type: "integer", minimum: 0 },
  },
} as const;

export interface AppDeps {
  db: Pool;
  environment: string;
  /** Shared with the worker; the only credential that may change Stock. */
  internalInventoryToken: string;
  /** Presented by the storefront on behalf of the signed-in Merchant. */
  adminServiceToken: string;
  /** Presented by the control plane to purge a deleted shop from this cell. */
  platformCellToken: string;
  /** Verifies the tenant context every business request carries (from the router, via the storefront). */
  tenantContextSecret: string;
}

export function buildApp(deps: AppDeps) {
  const app = createService({
    name: "catalog-cart-api",
    environment: deps.environment,
    db: deps.db,
    tenantContextSecret: deps.tenantContextSecret,
  });
  // Every business query runs in a transaction scoped to the request's tenant.
  const asTenant = <T>(req: FastifyRequest, work: (client: PoolClient) => Promise<T>) =>
    withTenant(deps.db, tenantOf(req).id, work);

  app.get("/products", async (req): Promise<ProductList> => {
    return { products: await asTenant(req, listProducts) };
  });

  app.get<{ Params: { id: string } }>("/products/:id", async (req, reply) => {
    // A malformed id names no product, so it is a 404 rather than a database type error.
    const product = isUuid(req.params.id) ? await asTenant(req, (db) => findProduct(db, req.params.id)) : undefined;
    if (!product) return notFound(reply, "product");
    return product;
  });

  app.post("/carts", async (req, reply) => {
    return reply.code(201).send(await asTenant(req, createCart));
  });

  app.get<{ Params: { id: string } }>("/carts/:id", async (req, reply) => {
    const cart = isUuid(req.params.id) ? await asTenant(req, (db) => getCart(db, req.params.id)) : undefined;
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

      const result = await asTenant(req, (db) => setCartItemQuantity(db, id, productId, req.body.quantity));
      return result.outcome === "updated" ? result.cart : notFound(reply, result.missing);
    },
  );

  // Internal: called by the worker only. Not reachable through ingress (only the router is
  // exposed), and refused without the internal service token. The worker settles Orders, not
  // shop requests, so it carries no tenant context: the body names the Order's tenant, and the
  // internal token, which only the worker holds, is what makes that claim trusted.
  app.post<{ Body: InventoryEffectRequest }>(
    "/internal/inventory-effects",
    {
      ...withoutTenant,
      preHandler: requireSecretHeader("x-internal-token", deps.internalInventoryToken),
      schema: { body: inventoryEffectBody },
    },
    async (req) => {
      const { tenantId, orderId, action, items } = req.body;
      const outcome = await applyInventoryEffect(deps.db, tenantId.toLowerCase(), orderId.toLowerCase(), action, items);
      req.log.info({ tenantId, orderId, action, outcome }, "inventory effect");
      const result: InventoryEffectResult = { orderId, action, outcome };
      return result;
    },
  );

  app.post<{ Body: NewProduct }>(
    "/admin/products",
    { preHandler: requireSecretHeader("x-admin-token", deps.adminServiceToken), schema: { body: newProductBody } },
    async (req, reply) => {
      const product = await asTenant(req, (db) => addProduct(db, req.body));
      req.log.info({ productId: product.id }, "product added");
      return reply.code(201).send(product);
    },
  );

  // Internal: the control plane deletes a shop from this cell. Refused without the cell token,
  // which only the control plane holds; outside any tenant context, because the shop is no longer
  // routed. The schema's narrow purge function does the deleting (ADR-0012's pattern) and reports
  // what it removed and what of the shop is left.
  app.post<{ Params: { tenantId: string } }>(
    "/internal/tenants/:tenantId/purge",
    { ...withoutTenant, preHandler: requireSecretHeader("x-platform-token", deps.platformCellToken) },
    async (req, reply) => {
      const { tenantId } = req.params;
      if (!isUuid(tenantId)) return reply.code(404).send({ error: "tenant_not_found", message: "not a tenant id" });
      const { rows } = await deps.db.query<{ report: { deleted: Record<string, number>; remaining: Record<string, number> } }>(
        "SELECT catalog.purge_tenant($1) AS report",
        [tenantId.toLowerCase()],
      );
      req.log.info({ tenantId, ...rows[0]!.report }, "tenant purged");
      return rows[0]!.report;
    },
  );

  // Internal: the control plane gives a cell's synthetic shop (Phase 4) a product to buy, once.
  // The promoter checks a release out in every cell by buying it with the decline scenario, which
  // deducts and then releases Stock, so the Stock never runs down. Same token as a purge.
  app.post<{ Params: { tenantId: string } }>(
    "/internal/tenants/:tenantId/synthetic-catalog",
    { ...withoutTenant, preHandler: requireSecretHeader("x-platform-token", deps.platformCellToken) },
    async (req, reply) => {
      const { tenantId } = req.params;
      if (!isUuid(tenantId)) return reply.code(404).send({ error: "tenant_not_found", message: "not a tenant id" });
      const product = await withTenant(deps.db, tenantId.toLowerCase(), async (client) => {
        // Two concurrent calls for one shop would otherwise both find no product and add one each.
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`synthetic-catalog:${tenantId.toLowerCase()}`]);
        const existing = (await listProducts(client)).find((p) => p.name === syntheticProduct.name);
        return existing ?? (await addProduct(client, syntheticProduct));
      });
      req.log.info({ tenantId, productId: product.id }, "synthetic catalog ensured");
      return product;
    },
  );

  return app;
}

const syntheticProduct: NewProduct = {
  name: "Synthetic Probe",
  description: "Bought by the platform to check this cell; never shipped.",
  priceMinor: 100,
  stock: 1_000_000,
};
