import type { FastifyBaseLogger } from "fastify";
import { Counter, Gauge, type Registry } from "prom-client";
import type { TenantRoute, TenantRouteTable } from "@shop/contracts";

/** Where the router learns which shops exist and in what state. */
export interface RouteSource {
  /** The shop a handle names, or undefined when it names none (or a deleted one). */
  lookup(handle: string): TenantRoute | undefined;
  /** False until a first routing table is in hand. */
  ready(): boolean;
}

export interface RegistryRoutesOptions {
  platformApiUrl: string;
  routerToken: string;
  refreshMs: number;
  registry: Registry;
  log: FastifyBaseLogger;
}

/**
 * The control plane's routing table, loaded at start and refreshed every `refreshMs`. A failed
 * refresh keeps the last good table: buyers of existing shops keep being served while the control
 * plane is down, and only changes (new shops, suspensions) wait for it to return.
 */
export function registryRoutes({ platformApiUrl, routerToken, refreshMs, registry, log }: RegistryRoutesOptions) {
  let byHandle: Map<string, TenantRoute> | undefined;
  let loadedAt = 0;
  let failing = false;

  new Gauge({
    name: "router_routes_age_seconds",
    help: "Seconds since the routing table was last loaded from the control plane (-1 before the first load)",
    registers: [registry],
    collect() {
      this.set(loadedAt === 0 ? -1 : (Date.now() - loadedAt) / 1000);
    },
  });
  const failures = new Counter({
    name: "router_routes_refresh_failures_total",
    help: "Failed attempts to load the routing table from the control plane",
    registers: [registry],
  });

  async function refresh(): Promise<void> {
    try {
      const res = await fetch(`${platformApiUrl}/internal/routes`, {
        headers: { "x-platform-token": routerToken },
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) throw new Error(`control plane answered ${res.status}`);
      const table = (await res.json()) as TenantRouteTable;
      if (!Array.isArray(table.tenants)) throw new Error("routing table without tenants");
      byHandle = new Map(table.tenants.map((tenant) => [tenant.handle, tenant]));
      loadedAt = Date.now();
      if (failing) log.info({ tenants: table.tenants.length }, "routing table refreshed again");
      failing = false;
    } catch (err) {
      failures.inc();
      // One line when refreshes start failing, not one every interval.
      if (!failing) log.warn({ err, servingCachedTable: byHandle !== undefined }, "routing table refresh failed");
      failing = true;
    }
  }

  let timer: NodeJS.Timeout | undefined;
  const source: RouteSource & { start(): Promise<void>; stop(): void } = {
    lookup: (handle) => byHandle?.get(handle),
    ready: () => byHandle !== undefined,
    async start() {
      await refresh();
      timer = setInterval(() => void refresh(), refreshMs);
    },
    stop() {
      clearInterval(timer);
    },
  };
  return source;
}
