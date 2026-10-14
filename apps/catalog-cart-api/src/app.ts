import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import type { AdminUsage, InventoryEffectRequest, InventoryEffectResult, NewProduct, ProductList } from "@shop/contracts";
import { planLimits, type TenantContextSecrets } from "@shop/tenancy";
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
import { addProduct, countProducts, deleteProduct, findProduct, listProducts } from "./products.ts";

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
  tenantContextSecret: TenantContextSecrets;
  /**
   * Shop handles without a product quota: none in the cluster. The Compose test stack exempts the
   * seeded shops, whose catalogs grow with every test run on a volume that outlives the stack.
   */
  productQuotaExempt?: ReadonlySet<string>;
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

  // The plan's product quota (Phase 5), counted and enforced in the insert's own transaction under
  // a lock per shop, so two concurrent adds cannot both take the last place.
  app.post<{ Body: NewProduct }>(
    "/admin/products",
    { preHandler: requireSecretHeader("x-admin-token", deps.adminServiceToken), schema: { body: newProductBody } },
    async (req, reply) => {
      const shop = tenantOf(req);
      const limit = deps.productQuotaExempt?.has(shop.handle) ? Number.POSITIVE_INFINITY : planLimits[shop.plan].products;
      const product = await asTenant(req, async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`products:${shop.id}`]);
        return (await countProducts(db)) >= limit ? undefined : addProduct(db, req.body);
      });
      if (!product) {
        req.log.info({ limit }, "product refused: quota reached");
        return reply.code(409).send({ error: "product_quota", message: `this shop's plan allows ${limit} products` });
      }
      req.log.info({ productId: product.id }, "product added");
      return reply.code(201).send(product);
    },
  );

  // A Merchant deletes a product (Phase 6): out of every Cart, gone from the catalog. Orders keep
  // their own lines. A restore to an export from before brings it back.
  app.delete<{ Params: { id: string } }>(
    "/admin/products/:id",
    { preHandler: requireSecretHeader("x-admin-token", deps.adminServiceToken) },
    async (req, reply) => {
      const { id } = req.params;
      const deleted = isUuid(id) && (await asTenant(req, (db) => deleteProduct(db, id)));
      if (!deleted) return notFound(reply, "product");
      req.log.info({ productId: id }, "product deleted");
      return reply.code(204).send();
    },
  );

  app.get(
    "/admin/usage",
    { preHandler: requireSecretHeader("x-admin-token", deps.adminServiceToken) },
    async (req): Promise<AdminUsage> => {
      const shop = tenantOf(req);
      const limits = planLimits[shop.plan];
      return {
        plan: shop.plan,
        products: await asTenant(req, countProducts),
        productLimit: limits.products,
        requestsPerSecond: limits.requestsPerSecond,
        burst: limits.burst,
      };
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

  // Internal, Phase 6: the control plane moves or restores a shop by exporting its rows from one
  // cell, importing them into another, and comparing each table's count and checksum in both. Same
  // token and pattern as a purge: the schema's narrow functions do the work, scoped to one tenant.
  // An import refuses a shop that already has rows here (409) and rows of another tenant (422).
  app.post<{ Params: { tenantId: string } }>(
    "/internal/tenants/:tenantId/export",
    { ...withoutTenant, preHandler: requireSecretHeader("x-platform-token", deps.platformCellToken) },
    async (req, reply) => {
      const { tenantId } = req.params;
      if (!isUuid(tenantId)) return reply.code(404).send({ error: "tenant_not_found", message: "not a tenant id" });
      const tenant = tenantId.toLowerCase();
      const { rows } = await deps.db.query<{ rows: Record<string, unknown[]>; checksums: TenantChecksums }>(
        "SELECT catalog.export_tenant($1) AS rows, catalog.tenant_checksums($1) AS checksums",
        [tenant],
      );
      req.log.info({ tenantId, checksums: rows[0]!.checksums }, "tenant exported");
      return { tenantId: tenant, ...rows[0]! };
    },
  );

  app.post<{ Params: { tenantId: string }; Body: { rows: Record<string, unknown[]> } }>(
    "/internal/tenants/:tenantId/import",
    {
      ...withoutTenant,
      preHandler: requireSecretHeader("x-platform-token", deps.platformCellToken),
      bodyLimit: importBodyLimit,
      schema: { body: { type: "object", required: ["rows"], properties: { rows: { type: "object" } } } },
    },
    async (req, reply) => {
      const { tenantId } = req.params;
      if (!isUuid(tenantId)) return reply.code(404).send({ error: "tenant_not_found", message: "not a tenant id" });
      try {
        const { rows } = await deps.db.query<{ checksums: TenantChecksums }>(
          "SELECT catalog.import_tenant($1, $2) AS checksums",
          [tenantId.toLowerCase(), JSON.stringify(req.body.rows)],
        );
        req.log.info({ tenantId, checksums: rows[0]!.checksums }, "tenant imported");
        return { checksums: rows[0]!.checksums };
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "23505") return reply.code(409).send({ error: "tenant_not_empty", message: (err as Error).message });
        if (code === "23514") return reply.code(422).send({ error: "rows_refused", message: (err as Error).message });
        throw err;
      }
    },
  );

  app.get<{ Params: { tenantId: string } }>(
    "/internal/tenants/:tenantId/checksums",
    { ...withoutTenant, preHandler: requireSecretHeader("x-platform-token", deps.platformCellToken) },
    async (req, reply) => {
      const { tenantId } = req.params;
      if (!isUuid(tenantId)) return reply.code(404).send({ error: "tenant_not_found", message: "not a tenant id" });
      const { rows } = await deps.db.query<{ checksums: TenantChecksums }>(
        "SELECT catalog.tenant_checksums($1) AS checksums",
        [tenantId.toLowerCase()],
      );
      return { checksums: rows[0]!.checksums };
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

/** Each table's row count and md5 over its rows in key order, as the schema computes them. */
type TenantChecksums = Record<string, { rows: number; md5: string }>;

/** A shop's rows arrive in one request; lab shops are far smaller than this. */
const importBodyLimit = 32 * 1024 * 1024;
