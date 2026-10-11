import "server-only";
import { headers } from "next/headers";
import { tenantContextHeader } from "@shop/tenancy";
import { requiredEnv } from "./env";

/**
 * Builds a URL on one of the backend APIs from its base-URL environment variable. Server-side
 * only: the browser never learns these addresses or calls the APIs itself.
 */
export function backendUrl(baseUrlVariable: Backend, path: string): string {
  return `${requiredEnv(baseUrlVariable)}${path}`;
}

type Backend = "CATALOG_API_URL" | "ORDER_SERVICE_URL";

/**
 * Calls a backend API, never cached, carrying this request's `x-request-id` (set by proxy.ts) so
 * one buyer request can be followed through the storefront's and the APIs' logs, and the
 * router's signed tenant context (verified by proxy.ts), so the API serves the same shop.
 */
export async function backendFetch(backend: Backend, path: string, init: RequestInit = {}): Promise<Response> {
  const requestHeaders = new Headers(init.headers);
  const incoming = await headers();
  const requestId = incoming.get("x-request-id");
  if (requestId) requestHeaders.set("x-request-id", requestId);
  const tenantContext = incoming.get(tenantContextHeader);
  if (tenantContext) requestHeaders.set(tenantContextHeader, tenantContext);
  return fetch(backendUrl(backend, path), { cache: "no-store", ...init, headers: requestHeaders });
}

