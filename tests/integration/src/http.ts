import { expect } from "vitest";
import { signTenantContext, tenantContextHeader, type Tenant } from "@shop/tenancy";
import { secret } from "./secrets.ts";
import { tenants } from "./tenants.ts";

export const catalogApiUrl = process.env.CATALOG_API_URL ?? "http://127.0.0.1:4001";
export const orderServiceUrl = process.env.ORDER_SERVICE_URL ?? "http://127.0.0.1:4002";
export const storefrontUrl = process.env.STOREFRONT_URL ?? "http://127.0.0.1:3000";
/** The control plane's internal listener (never on an ingress; published on loopback for tests). */
export const platformInternalUrl = process.env.PLATFORM_INTERNAL_URL ?? "http://127.0.0.1:8101";

/** A signed tenant context for `tenant`, as the router would attach it. */
export function tenantContextFor(tenant: Tenant): string {
  return signTenantContext(tenant, secret("TENANT_CONTEXT_SECRET"));
}

/**
 * Calls one of the APIs directly, as `tenant` (Harbor Goods unless told otherwise): the request
 * carries a freshly signed tenant context, as it would coming from the storefront.
 */
export function api(url: string, init: RequestInit = {}, tenant: Tenant = tenants.harbor): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(tenantContextHeader, tenantContextFor(tenant));
  return fetch(url, { ...init, headers });
}

export async function getJson<T>(url: string, tenant: Tenant = tenants.harbor): Promise<{ status: number; body: T }> {
  const res = await api(url, {}, tenant);
  return { status: res.status, body: (await res.json()) as T };
}

export async function statusOf(url: string): Promise<number> {
  try {
    return (await api(url, { signal: AbortSignal.timeout(3_000) })).status;
  } catch {
    return 0;
  }
}

/** Waits for the catalog-cart API to report ready again, e.g. after a test stopped a container. */
export async function waitUntilCatalogReady(): Promise<void> {
  await expect
    .poll(() => statusOf(`${catalogApiUrl}/health/ready`), { timeout: 30_000, interval: 500 })
    .toBe(200);
}

/** Polls until `check` passes; for setup hooks and multi-step waits, where expect.poll doesn't fit. */
export async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${what}: not true after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Polls a URL until it answers 200. */
export async function waitForOk(url: string, timeoutMs = 30_000): Promise<void> {
  await waitFor(async () => (await statusOf(url)) === 200, `${url} ready`, timeoutMs);
}

