import type { CellEndpoints } from "./cells.ts";

/** Each table's row count and md5 over its rows in key order, as the cell's schemas compute them. */
export type Checksums = Record<string, { rows: number; md5: string }>;
/** One shop's rows, one array per table (`schema.table`). */
export type TenantRows = Record<string, Record<string, unknown>[]>;
/** Rows a purge removed and rows of the shop left afterwards, per table. */
export interface PurgeReport {
  deleted: Record<string, number>;
  remaining: Record<string, number>;
}

/** The two APIs of a cell that hold a shop's rows: the catalog (with Carts) and the Orders. */
export const services = ["catalog", "orders"] as const;
export type Service = (typeof services)[number];

/**
 * A cell's internal tenant-data endpoints (ticket 01 and the purge), called with that cell's own
 * token: a cell's token opens no other cell.
 */
export class CellData {
  constructor(
    readonly cell: CellEndpoints,
    private readonly token: string,
    private readonly timeoutMs = 30_000,
  ) {}

  private async call<T>(service: Service, path: string, init: { method: string; body?: unknown }): Promise<T> {
    const base = service === "catalog" ? this.cell.catalogUrl : this.cell.ordersUrl;
    const res = await fetch(`${base}/internal/tenants/${path}`, {
      method: init.method,
      headers: { "x-platform-token": this.token, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`${service} ${path.split("/")[1]} in ${this.cell.id} answered ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  export(service: Service, tenantId: string): Promise<{ rows: TenantRows; checksums: Checksums }> {
    return this.call(service, `${tenantId}/export`, { method: "POST" });
  }

  async import(service: Service, tenantId: string, rows: TenantRows): Promise<Checksums> {
    return (await this.call<{ checksums: Checksums }>(service, `${tenantId}/import`, { method: "POST", body: { rows } })).checksums;
  }

  async checksums(service: Service, tenantId: string): Promise<Checksums> {
    return (await this.call<{ checksums: Checksums }>(service, `${tenantId}/checksums`, { method: "GET" })).checksums;
  }

  purge(service: Service, tenantId: string): Promise<PurgeReport> {
    return this.call(service, `${tenantId}/purge`, { method: "POST" });
  }

  /** Purges a shop from both APIs, Orders first, and reports what is left of it. */
  async purgeAll(tenantId: string): Promise<PurgeReport> {
    const orders = await this.purge("orders", tenantId);
    const catalog = await this.purge("catalog", tenantId);
    return { deleted: { ...orders.deleted, ...catalog.deleted }, remaining: { ...orders.remaining, ...catalog.remaining } };
  }
}

export const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, n) => sum + n, 0);

/** The tables whose rows or md5 differ between two sets of checksums (both directions). */
export function differences(a: Checksums, b: Checksums): string[] {
  const tables = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...tables].filter((table) => a[table]?.rows !== b[table]?.rows || a[table]?.md5 !== b[table]?.md5).sort();
}
