import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { tenantContextHeader, verifyTenantContext } from "@shop/tenancy";

const environment = process.env.APP_ENV ?? "dev";

/** The cell's current secret, and during a rotation (Phase 7) the next one as well. */
function tenantContextSecret(): string[] {
  const secret = process.env.TENANT_CONTEXT_SECRET;
  if (!secret) throw new Error("missing required environment variable TENANT_CONTEXT_SECRET");
  return [secret, process.env.TENANT_CONTEXT_SECRET_NEXT].filter((s): s is string => !!s);
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

  // A shop frozen for a move or a restore (Phase 6) is browsed but not written: its cart, Checkout,
  // and Merchant forms get the updating page (the APIs would refuse the writes anyway). Signing in
  // and out writes nothing in the cell, so the Merchant can still read their admin.
  if (tenant.readOnly && request.method === "POST" && !request.nextUrl.pathname.startsWith("/admin/session")) {
    return shopUpdating(requestId);
  }

  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("x-request-id", requestId);
  return response;
}

/** 503 with Retry-After: the shop is moments from taking writes again, not broken. */
function shopUpdating(requestId: string): NextResponse {
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>This shop is updating</title></head>
<body><main><h1>This shop is updating</h1>
<p>This shop is updating, try again in a moment. You can keep browsing meanwhile.</p>
<p><a href="/">Back to the shop</a></p></main></body></html>`;
  return new NextResponse(page, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "retry-after": "5", "x-request-id": requestId },
  });
}

export const config = {
  // Static assets and the container health check are not worth a log line each.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|healthz).*)"],
};
