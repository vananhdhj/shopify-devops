import type { CellRole } from "@shop/contracts";
import type { Queryable } from "@shop/service-kit";

/** What a cell API's readiness endpoint said: `unreachable` when nothing answered in time. */
export type Readiness = "ready" | "not_ready" | "unreachable";

const statuses = ["PROVISIONING", "ACTIVE", "SUSPENDED", "DELETING", "DELETED"] as const;

export interface CellView {
  id: string;
  role: CellRole;
  capacity: number;
  /** When the cell first registered; null for a cell in the directory that never has (or was set aside). */
  registeredAt: string | null;
  /** Shops placed in the cell, by status, every status present (zero when none). */
  shops: Record<(typeof statuses)[number], number>;
  /** Shops counting against the capacity: every status but DELETED. */
  placed: number;
  /** Readiness of the cell's catalog and order APIs, asked now; null for an unregistered cell. */
  apis: { catalog: Readiness; orders: Readiness } | null;
}

/**
 * Longer than a cell API's own database connect timeout (2 s), so an API whose database does not
 * answer is reported `not_ready`, as it reports itself, rather than `unreachable`.
 */
const readinessTimeoutMs = 2_500;

async function readiness(baseUrl: string): Promise<Readiness> {
  try {
    const res = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(readinessTimeoutMs) });
    await res.body?.cancel();
    return res.ok ? "ready" : "not_ready";
  } catch {
    return "unreachable";
  }
}

/**
 * The fleet as the control plane sees it: every cell in the directory, its shops by status, and
 * whether its APIs are ready right now. The APIs of all cells are asked at once, each with a short
 * timeout, so one cell that hangs costs the view at most that timeout and never fails it.
 */
export async function fleetView(db: Queryable): Promise<CellView[]> {
  const cells = await db.query<{
    id: string;
    role: CellRole;
    capacity: number;
    registered_at: Date | null;
    catalog_url: string | null;
    orders_url: string | null;
  }>("SELECT id, role, capacity, registered_at, catalog_url, orders_url FROM platform.cells ORDER BY id");
  const counts = await db.query<{ cell: string; status: (typeof statuses)[number]; n: number }>(
    "SELECT cell, status, count(*)::int AS n FROM platform.tenants WHERE cell IS NOT NULL GROUP BY cell, status",
  );

  return Promise.all(
    cells.rows.map(async (cell): Promise<CellView> => {
      const shops = Object.fromEntries(statuses.map((status) => [status, 0])) as CellView["shops"];
      for (const row of counts.rows) if (row.cell === cell.id) shops[row.status] = row.n;
      const registered = cell.registered_at !== null && cell.catalog_url !== null && cell.orders_url !== null;
      const [catalog, orders] = registered
        ? await Promise.all([readiness(cell.catalog_url!), readiness(cell.orders_url!)])
        : [undefined, undefined];
      return {
        id: cell.id,
        role: cell.role,
        capacity: cell.capacity,
        registeredAt: cell.registered_at?.toISOString() ?? null,
        shops,
        placed: statuses.filter((status) => status !== "DELETED").reduce((sum, status) => sum + shops[status], 0),
        apis: catalog && orders ? { catalog, orders } : null,
      };
    }),
  );
}
