# 01: Walking skeleton — products visible from a clean checkout

**What to build:** From a clean checkout, the developer runs one command and a Guest buyer can open the storefront and see the seeded products with their prices and availability. This establishes the monorepo (pnpm workspaces + Turborepo, Node 24 LTS, TypeScript), the Compose stack on Colima (PostgreSQL, Redis, dbmate migration job, seed job), the `catalog` schema with its owning identity, the catalog-cart API's product list and detail endpoints, the storefront product pages calling the API server-side, and the service-HTTP test harness that every later ticket extends. Secrets are generated locally by `make secrets`; Gitleaks guards commits from the very first one.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] `make secrets`, `make dev-up`, `make seed`, `make test`, `make dev-down` work from a clean checkout; each reports success only after its health checks pass
- [x] Seeded data contains about 12 products, two of them with a stock of 1; prices are integer minor units and stock is never negative (database constraints)
- [x] Storefront listing and product detail pages render seeded products; the browser never calls the API directly
- [x] Seam-1 test: listing and detail return the same product and server-owned price
- [x] Catalog-cart API exposes liveness, readiness, and metrics endpoints; readiness fails when PostgreSQL is unreachable while liveness stays healthy
- [x] On termination the API stops accepting new requests and drains in-flight requests within a bound
- [x] Every image is multi-stage, runs as non-root, and takes configuration only from the environment
- [x] Generated secrets live only in a gitignored local file; a Gitleaks pre-commit hook blocks a committed fake secret
- [x] Logs are structured JSON with service, environment, severity, and request ID (catalog-cart API; storefront moved to ticket 09)

## Comments

Resolved 2026-10-10. `make test` passes from a wiped stack: typecheck plus 12 service-HTTP tests (product listing/detail agreement, 404s, readiness vs liveness with PostgreSQL stopped, route-template metrics, JSON logs with correlation ID, clean SIGTERM exit, storefront pages rendered server-side). Gitleaks pre-commit hook verified by hand against a fake GitHub token.

Decided in review: the migration identity owns the schemas; runtime identities get table privileges only (spec updated). `catalog_app` currently has SELECT only.

Deferred from review: storefront JSON logs and request-ID forwarding (09); in-flight drain test (04); CI secret scanning for unhooked commits (07); schema bootstrap for the in-cluster migration job (08).
