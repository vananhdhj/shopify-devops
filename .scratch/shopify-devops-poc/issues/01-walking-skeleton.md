# 01: Walking skeleton — products visible from a clean checkout

**What to build:** From a clean checkout, the developer runs one command and a Guest buyer can open the storefront and see the seeded products with their prices and availability. This establishes the monorepo (pnpm workspaces + Turborepo, Node 24 LTS, TypeScript), the Compose stack on Colima (PostgreSQL, Redis, dbmate migration job, seed job), the `catalog` schema with its owning identity, the catalog-cart API's product list and detail endpoints, the storefront product pages calling the API server-side, and the service-HTTP test harness that every later ticket extends. Secrets are generated locally by `make secrets`; Gitleaks guards commits from the very first one.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `make secrets`, `make dev-up`, `make seed`, `make test`, `make dev-down` work from a clean checkout; each reports success only after its health checks pass
- [ ] Seeded data contains about 12 products, two of them with a stock of 1; prices are integer minor units and stock is never negative (database constraints)
- [ ] Storefront listing and product detail pages render seeded products; the browser never calls the API directly
- [ ] Seam-1 test: listing and detail return the same product and server-owned price
- [ ] Catalog-cart API exposes liveness, readiness, and metrics endpoints; readiness fails when PostgreSQL is unreachable while liveness stays healthy
- [ ] On termination the API stops accepting new requests and drains in-flight requests within a bound
- [ ] Every image is multi-stage, runs as non-root, and takes configuration only from the environment
- [ ] Generated secrets live only in a gitignored local file; a Gitleaks pre-commit hook blocks a committed fake secret
- [ ] Logs are structured JSON with service, environment, severity, and request ID
