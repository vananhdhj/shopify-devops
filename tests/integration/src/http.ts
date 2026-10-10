import { expect } from "vitest";

export const catalogApiUrl = process.env.CATALOG_API_URL ?? "http://127.0.0.1:4001";
export const storefrontUrl = process.env.STOREFRONT_URL ?? "http://127.0.0.1:3000";

export async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as T };
}

export async function statusOf(url: string): Promise<number> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(3_000) })).status;
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

