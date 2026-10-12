import type { TenantRoute } from "@shop/contracts";
import type { CellCredentials } from "@shop/tenancy";
import type { RouteSource } from "./routes.ts";

/** Where one shop's requests go, and the secret its tenant context is signed with there. */
export interface Upstream {
  cell: string;
  storefrontUrl: string;
  tenantContextSecret: string;
}

/** Why a shop that is active cannot be proxied: its cell is not usable from this router. */
export type Unroutable = "unplaced" | "unknown_cell" | "no_secret";

/** Picks the upstream of an active shop. */
export type UpstreamFor = (tenant: TenantRoute) => Upstream | Unroutable;

/**
 * The edge: every shop goes to the storefront of the cell holding it, with a tenant context signed
 * by that cell's secret, so a cell only ever receives its own shops and could not verify a
 * context meant for another. A shop whose cell is unregistered, or whose secret this router lacks,
 * is unroutable: never sent to some other cell.
 */
export function cellUpstreams(routes: RouteSource, credentials: CellCredentials): UpstreamFor {
  return (tenant) => {
    if (tenant.cell === null) return "unplaced";
    const cell = routes.cell(tenant.cell);
    if (!cell) return "unknown_cell";
    const tenantContextSecret = credentials.get(cell.id, "tenant-context-secret");
    if (!tenantContextSecret) return "no_secret";
    return { cell: cell.id, storefrontUrl: cell.storefrontUrl, tenantContextSecret };
  };
}

/**
 * A router inside one cell (Phase 1 and 2): every shop goes to that cell's storefront. Removed when
 * the edge takes the ingress (Phase 3 ticket 03).
 */
export function singleCellUpstream(cell: string, storefrontUrl: string, tenantContextSecret: string): UpstreamFor {
  const upstream = { cell, storefrontUrl, tenantContextSecret };
  return () => upstream;
}
