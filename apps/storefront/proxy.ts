import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

const environment = process.env.APP_ENV ?? "dev";

/**
 * Runs before every page and form request. Gives the request a correlation ID (the caller's
 * `x-request-id`, or a new one), passes it on to the backend calls (lib/backend.ts) and back to
 * the browser, and writes one structured JSON log line in the same shape as the APIs' logs.
 * Only the path is logged, never the query string: Order links carry their Order token there
 * (ADR-0004).
 */
export function proxy(request: NextRequest) {
  const given = request.headers.get("x-request-id");
  const requestId = given && given.length <= 128 ? given : randomUUID();

  console.log(
    JSON.stringify({
      severity: "info",
      time: new Date().toISOString(),
      service: "storefront",
      environment,
      requestId,
      req: { method: request.method, path: request.nextUrl.pathname },
      message: "incoming request",
    }),
  );

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
