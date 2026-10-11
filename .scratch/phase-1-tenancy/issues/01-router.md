# 01: Router — host to tenant, signed tenant context

**What to build:** A new deployment unit, `apps/router`, that maps a request's host to a tenant from the static tenant table and proxies it to the storefront with a freshly signed tenant context. This ticket ships the router and its image on its own, so its first digest exists on `main` before any manifest references it (see the spec's Delivery section). The storefront ignores the context until ticket 02.

**Blocked by:** none

**Status:** ready-for-agent

- [ ] `deploy/base/tenants.json` lists `harbor` and `meadow` with fixed ids, handles, and names
- [ ] `@shop/tenancy` signs and verifies the tenant context (60 s validity, 5 s skew)
- [ ] The router resolves `<handle>.<TENANT_BASE_DOMAIN>` to a tenant, drops any client-supplied context, adds a signed one, preserves `Host`, and proxies every method and body to the storefront
- [ ] Unknown handles, the bare base domain, and other hosts answer `404` with a fixed body, without contacting the storefront
- [ ] Liveness, readiness (tenant table loaded), metrics, and structured logs with the tenant handle on request lines
- [ ] `make secrets` generates `TENANT_CONTEXT_SECRET`; Compose runs the router on `127.0.0.1:8000`
- [ ] CI and release build the router image for both architectures; the dev-overlay digest job adds an image entry when none exists
- [ ] Seam-1 tests: each handle reaches the storefront with a context that verifies for that tenant; a forged client context is replaced; an unknown host gets the fixed `404`; a form post arrives at the storefront unchanged

## Comments
