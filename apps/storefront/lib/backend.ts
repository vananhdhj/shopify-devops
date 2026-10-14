import "server-only";
import { context, propagation } from "@opentelemetry/api";
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
 * router's signed tenant context (verified by proxy.ts), so the API serves the same shop, and
 * the request's trace context (Phase 7), so the API's spans join the buyer's trace.
 */
export async function backendFetch(backend: Backend, path: string, init: RequestInit = {}): Promise<Response> {
  const requestHeaders = new Headers(init.headers);
  const incoming = await headers();
  const requestId = incoming.get("x-request-id");
  if (requestId) requestHeaders.set("x-request-id", requestId);
  const tenantContext = incoming.get(tenantContextHeader);
  if (tenantContext) requestHeaders.set(tenantContextHeader, tenantContext);
  const trace: Record<string, string> = {};
  propagation.inject(context.active(), trace);
  for (const [name, value] of Object.entries(trace)) requestHeaders.set(name, value);
  return fetch(backendUrl(backend, path), { cache: "no-store", ...init, headers: requestHeaders });
}

