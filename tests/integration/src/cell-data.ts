import { expect } from "vitest";
import { catalogApiUrl, orderServiceUrl } from "./http.ts";
import { cellSecret } from "./secrets.ts";

/**
 * Each Compose cell's internal tenant-data endpoints (Phase 6: export, import, checksums, purge),
 * called with that cell's own token, for tests about where a shop's rows are.
 */
/** Each cell's catalog API and order service, as published on loopback by Compose. */
export const cells = {
  "pool-1": { catalog: catalogApiUrl, orders: orderServiceUrl },
  "dedicated-1": { catalog: "http://127.0.0.1:4021", orders: "http://127.0.0.1:4022" },
} as const;
export type Cell = keyof typeof cells;
export type Service = "catalog" | "orders";
export type Checksums = Record<string, { rows: number; md5: string }>;
export type Rows = Record<string, Record<string, unknown>[]>;

export function internal(cell: Cell, service: Service, path: string, init: { method?: string; body?: unknown; token?: string | null } = {}) {
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

export async function exportOf(cell: Cell, service: Service, tenantId: string): Promise<{ rows: Rows; checksums: Checksums }> {
  const res = await internal(cell, service, `${tenantId}/export`, { method: "POST" });
  expect(res.status).toBe(200);
  return (await res.json()) as { rows: Rows; checksums: Checksums };
}

export async function checksumsOf(cell: Cell, service: Service, tenantId: string): Promise<Checksums> {
  const res = await internal(cell, service, `${tenantId}/checksums`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { checksums: Checksums }).checksums;
}

export const importInto = (cell: Cell, service: Service, tenantId: string, rows: Rows) =>
  internal(cell, service, `${tenantId}/import`, { method: "POST", body: { rows } });

export async function purge(cell: Cell, tenantId: string): Promise<void> {
  for (const service of ["catalog", "orders"] as const) {
    expect((await internal(cell, service, `${tenantId}/purge`, { method: "POST" })).status).toBe(200);
  }
}

export const empty = (checksums: Checksums) => Object.values(checksums).every((table) => table.rows === 0);

/** A shop's checksums in both of a cell's APIs, as one record keyed by table. */
export async function shopChecksums(cell: Cell, tenantId: string): Promise<Checksums> {
  return { ...(await checksumsOf(cell, "catalog", tenantId)), ...(await checksumsOf(cell, "orders", tenantId)) };
}
