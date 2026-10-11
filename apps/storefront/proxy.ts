import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { tenantContextHeader, verifyTenantContext } from "@shop/tenancy";

const environment = process.env.APP_ENV ?? "dev";

function tenantContextSecret(): string {
  const secret = process.env.TENANT_CONTEXT_SECRET;
  if (!secret) throw new Error("missing required environment variable TENANT_CONTEXT_SECRET");
  return secret;
}

/**
 * Runs before every page and form request. A request without a valid tenant context from the
 * router names no shop, so it gets the router's own "no shop" answer: reaching the storefront
 * around the router serves nothing. Otherwise it gives the request a correlation ID (the
 * caller's `x-request-id`, or a new one), passes it on to the backend calls (lib/backend.ts) and
 * back to the browser, and writes one structured JSON log line in the same shape as the APIs'
 * logs, naming the shop. Only the path is logged, never the query string: Order links carry
 * their Order token there (ADR-0004).
 */
export function proxy(request: NextRequest) {
  const given = request.headers.get("x-request-id");
  const requestId = given && given.length <= 128 ? given : randomUUID();
  const tenant = verifyTenantContext(request.headers.get(tenantContextHeader), tenantContextSecret());

  console.log(
    JSON.stringify({
      severity: "info",
      time: new Date().toISOString(),
      service: "storefront",
      environment,
      requestId,
      ...(tenant ? { tenantId: tenant.id, tenant: tenant.handle } : {}),
      req: { method: request.method, path: request.nextUrl.pathname },
      message: tenant ? "incoming request" : "refused: no tenant context",
    }),
  );
  if (!tenant) {
    return new NextResponse("No shop at this address.\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("x-request-id", requestId);
  return response;
}

export const config = {
  // Static assets and the container health check are not worth a log line each.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|healthz).*)"],
};
