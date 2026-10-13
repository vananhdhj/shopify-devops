import { beforeAll, describe, expect, it } from "vitest";
import { cellQuery } from "./db.ts";
import { catalogApiUrl, orderServiceUrl, waitFor } from "./http.ts";
import { cellSecret } from "./secrets.ts";
import { seedProducts } from "./seed.ts";
import { checkoutOf, settled } from "./shopping.ts";
import { secondCellRunning } from "./stack.ts";
import { tenants } from "./tenants.ts";

/**
 * Phase 6's per-cell export, import, and checksums: Harbor Goods' rows out of pool-1 and into
 * dedicated-1, through each cell's internal endpoints with that cell's own token, and purged from
 * dedicated-1 again at the end. Runs only with the second cell up (`make dev-up CELLS=2`).
 */
const twoCells = secondCellRunning();
if (!twoCells) console.warn("tenant data tests skipped: the second cell is not running (make dev-up CELLS=2)");

/** Each cell's catalog API and order service, as published on loopback by Compose. */
const cells = {
  "pool-1": { catalog: catalogApiUrl, orders: orderServiceUrl },
  "dedicated-1": { catalog: "http://127.0.0.1:4021", orders: "http://127.0.0.1:4022" },
} as const;
type Cell = keyof typeof cells;
type Service = "catalog" | "orders";
type Checksums = Record<string, { rows: number; md5: string }>;
type Rows = Record<string, Record<string, unknown>[]>;

function internal(cell: Cell, service: Service, path: string, init: { method?: string; body?: unknown; token?: string | null } = {}) {
  const token = init.token === undefined ? cellSecret(cell, "PLATFORM_CELL_TOKEN") : init.token;
  return fetch(`${cells[cell][service]}/internal/tenants/${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === null ? {} : { "x-platform-token": token }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function exportOf(cell: Cell, service: Service, tenantId: string): Promise<{ rows: Rows; checksums: Checksums }> {
  const res = await internal(cell, service, `${tenantId}/export`, { method: "POST" });
  expect(res.status).toBe(200);
  return (await res.json()) as { rows: Rows; checksums: Checksums };
}

async function checksumsOf(cell: Cell, service: Service, tenantId: string): Promise<Checksums> {
  const res = await internal(cell, service, `${tenantId}/checksums`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { checksums: Checksums }).checksums;
}

const importInto = (cell: Cell, service: Service, tenantId: string, rows: Rows) =>
  internal(cell, service, `${tenantId}/import`, { method: "POST", body: { rows } });

async function purge(cell: Cell, tenantId: string): Promise<void> {
  for (const service of ["catalog", "orders"] as const) {
    expect((await internal(cell, service, `${tenantId}/purge`, { method: "POST" })).status).toBe(200);
  }
}

/** The same rows, each table's array reversed, so an import sees them in another order. */
const reversed = (rows: Rows): Rows => Object.fromEntries(Object.entries(rows).map(([table, list]) => [table, [...list].reverse()]));

const empty = (checksums: Checksums) => Object.values(checksums).every((table) => table.rows === 0);

describe.skipIf(!twoCells)("tenant export, import, and checksums", () => {
  beforeAll(async () => {
    // An interrupted earlier run may have left Harbor's copy in dedicated-1.
    await purge("dedicated-1", tenants.harbor.id);
    // Harbor has Orders of more than one status to carry over, whatever ran before this file.
    const confirmed = await checkoutOf({ [seedProducts.canvasTote]: 1 }, "approve");
    const rejected = await checkoutOf({ [seedProducts.enamelMug]: 1 }, "decline");
    expect((await settled(confirmed.orderId, confirmed.orderToken)).status).toBe("CONFIRMED");
    expect((await settled(rejected.orderId, rejected.orderToken)).status).toBe("REJECTED_PAYMENT");
    // As a move does, wait for Harbor's Pending Orders to settle first: dedicated-1's worker would
    // otherwise settle the imported ones while the test compares checksums.
    await waitFor(
      async () => (await cellQuery("pool-1", "SELECT 1 FROM orders.orders WHERE tenant_id = $1 AND status = 'PENDING'", [tenants.harbor.id])).length === 0,
      "Harbor has no Pending Order",
      60_000,
    );
  }, 120_000);

  it("copies a shop's rows into another cell with equal counts and checksums, whatever their order", async () => {
    const meadowBefore = {
      pool: { catalog: await checksumsOf("pool-1", "catalog", tenants.meadow.id), orders: await checksumsOf("pool-1", "orders", tenants.meadow.id) },
      dedicated: { catalog: await checksumsOf("dedicated-1", "catalog", tenants.meadow.id), orders: await checksumsOf("dedicated-1", "orders", tenants.meadow.id) },
    };
    for (const service of ["catalog", "orders"] as const) {
      const source = await exportOf("pool-1", service, tenants.harbor.id);
      expect(empty(source.checksums)).toBe(false);
      expect(empty(await checksumsOf("dedicated-1", service, tenants.harbor.id))).toBe(true);

      const res = await importInto("dedicated-1", service, tenants.harbor.id, reversed(source.rows));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { checksums: Checksums }).checksums).toEqual(source.checksums);
      expect(await checksumsOf("dedicated-1", service, tenants.harbor.id)).toEqual(source.checksums);
    }
    const orders = await cellQuery<{ status: string }>("dedicated-1", "SELECT DISTINCT status FROM orders.orders WHERE tenant_id = $1", [tenants.harbor.id]);
    expect(orders.map((o) => o.status)).toEqual(expect.arrayContaining(["CONFIRMED", "REJECTED_PAYMENT"]));

    // No other shop's rows changed in either cell.
    expect({
      pool: { catalog: await checksumsOf("pool-1", "catalog", tenants.meadow.id), orders: await checksumsOf("pool-1", "orders", tenants.meadow.id) },
      dedicated: { catalog: await checksumsOf("dedicated-1", "catalog", tenants.meadow.id), orders: await checksumsOf("dedicated-1", "orders", tenants.meadow.id) },
    }).toEqual(meadowBefore);
  });

  it("refuses to import into a shop that already has rows in the cell", async () => {
    for (const service of ["catalog", "orders"] as const) {
      const { rows } = await exportOf("pool-1", service, tenants.harbor.id);
      const before = await checksumsOf("dedicated-1", service, tenants.harbor.id);
      const res = await importInto("dedicated-1", service, tenants.harbor.id, rows);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "tenant_not_empty" });
      expect(await checksumsOf("dedicated-1", service, tenants.harbor.id)).toEqual(before);
    }
  });

  it("refuses rows of another tenant, and writes none of them", async () => {
    for (const service of ["catalog", "orders"] as const) {
      const { rows } = await exportOf("pool-1", service, tenants.harbor.id);
      const res = await importInto("dedicated-1", service, tenants.meadow.id, rows);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: "rows_refused" });
      expect(empty(await checksumsOf("dedicated-1", service, tenants.meadow.id))).toBe(true);
    }
  });

  it("answers only the control plane's token for this cell", async () => {
    for (const service of ["catalog", "orders"] as const) {
      for (const token of [null, cellSecret("pool-1", "PLATFORM_CELL_TOKEN")]) {
        expect((await internal("dedicated-1", service, `${tenants.harbor.id}/export`, { method: "POST", token })).status).toBe(401);
        expect((await internal("dedicated-1", service, `${tenants.harbor.id}/checksums`, { token })).status).toBe(401);
        expect((await internal("dedicated-1", service, `${tenants.meadow.id}/import`, { method: "POST", body: { rows: {} }, token })).status).toBe(401);
      }
      expect((await internal("dedicated-1", service, "not-a-tenant/checksums")).status).toBe(404);
    }
  });

  it("purges the copy from dedicated-1 and leaves the original in pool-1", async () => {
    const original = {
      catalog: await checksumsOf("pool-1", "catalog", tenants.harbor.id),
      orders: await checksumsOf("pool-1", "orders", tenants.harbor.id),
    };
    await purge("dedicated-1", tenants.harbor.id);
    for (const service of ["catalog", "orders"] as const) {
      expect(empty(await checksumsOf("dedicated-1", service, tenants.harbor.id))).toBe(true);
      expect(await checksumsOf("pool-1", service, tenants.harbor.id)).toEqual(original[service]);
    }
  });
});
