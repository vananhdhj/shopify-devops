# 01: Router — host to tenant, signed tenant context

**What to build:** A new deployment unit, `apps/router`, that maps a request's host to a tenant from the static tenant table and proxies it to the storefront with a freshly signed tenant context. This ticket ships the router and its image on its own, so its first digest exists on `main` before any manifest references it (see the spec's Delivery section). The storefront ignores the context until ticket 02.

**Blocked by:** none

**Status:** resolved

- [x] `deploy/base/tenants.json` lists `harbor` and `meadow` with fixed ids, handles, and names
- [x] `@shop/tenancy` signs and verifies the tenant context (60 s validity, 5 s skew)
- [x] The router resolves `<handle>.<TENANT_BASE_DOMAIN>` to a tenant, drops any client-supplied context, adds a signed one, preserves `Host`, and proxies every method and body to the storefront
- [x] Unknown handles, the bare base domain, and other hosts answer `404` with a fixed body, without contacting the storefront
- [x] Liveness, readiness (tenant table loaded), metrics, and structured logs with the tenant handle on request lines
- [x] `make secrets` generates `TENANT_CONTEXT_SECRET`; Compose runs the router on `127.0.0.1:8000`
- [x] CI and release build the router image for both architectures; the dev-overlay digest job adds an image entry when none exists
- [x] Seam-1 tests: each handle reaches the storefront with a context that verifies for that tenant; a forged client context is replaced; an unknown host gets the fixed `404`; a form post arrives at the storefront unchanged

## Comments

Implementation notes (2026-10-11):
- The router's public port carries only proxied traffic; its health and metrics are on a private port (8001), like the storefront's metrics, because the public port is on the ingress. `createService` gained `recordRequests: false` so the ops listener's probes don't share the request histogram with proxied traffic, and the database became optional for units without one.
- `@fastify/reply-from` logs the full upstream URL, query string included, which would put Order tokens into logs (ADR-0004); its request logging is disabled. The router forwards its request id as `x-request-id`, so one id spans router, storefront, and APIs.
- The tests' storefront client sends an explicit `Host` through `node:http`, because `fetch` always sends the URL's host.
- In this ticket the storefront only verifies and logs the context (when `TENANT_CONTEXT_SECRET` is set); refusing requests without one is ticket 02.
- The release job's dev-overlay step now appends an image entry when the overlay has none, so the router's first build pins itself.

Resolved 2026-10-11. `make test` passes from a fresh build (23 files, 110 tests). New tests: each handle reaches the storefront with that shop's context (storefront and router log lines name it); a client-sent context, even one validly signed for the other shop, is replaced; an unknown handle, the bare base domain, a deeper subdomain, and another domain all get the same fixed 404 without reaching the storefront; a form post passes through unchanged; health and metrics are not on the public port.
