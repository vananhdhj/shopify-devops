# 04: Two shops on the lab cluster, and the record of Phase 1

**What to build:** The k3d dev environment serves both shops through the router, and the repository explains the multi-tenant model: glossary, ADRs, README, and the architecture doc.

**Blocked by:** 03

**Status:** ready-for-agent

- [x] Kubernetes: router Deployment and Service, tenant-table ConfigMap, Ingress for `*.shop.localhost` to the router, storefront no longer on the Ingress, new secrets wired
- [ ] `make smoke` checks both shops at `harbor.shop.localhost:8080` and `meadow.shop.localhost:8080`, and the unknown-shop `404`
- [x] `CONTEXT.md` gains Tenant, Handle, Tenant context, Cell, and Platform operator, and the Merchant definition becomes per tenant
- [x] ADRs: pooled tenancy with RLS as the isolation boundary; tenant identity from a signed router context; cross-tenant work only through narrow functions; amendments to ADR-0004 (tenant-bound Order token), ADR-0006 (role per schema, tenant per row), and ADR-0007 (token per cell, tenant from context)
- [ ] README and the architecture doc describe the router, tenancy, and the isolation suite (README done; architecture doc not yet)
- [ ] Measured memory of the dev environment with the router, recorded in `docs/evidence/`

## Comments

Progress (2026-10-11):
- Kubernetes wiring done and validated (kubeconform: dev 31 and staging 30 resources valid): router Deployment, Service, and the Ingress for `*.<base domain>` (the storefront left the ingress), the `shop-tenants` ConfigMap from `deploy/base/tenants.json`, `TENANT_BASE_DOMAIN` per overlay, `TENANT_CONTEXT_SECRET` and `MERCHANT_CREDENTIALS` wired, a PodMonitor for the router's private ops port, two router replicas in staging with a placeholder digest like db-migrations'.
- The dev router image is not pinned yet: its first digest appears on `main` when the release job builds PR #18 (ticket 01). This branch must be rebased onto that `main` before its PR can pass the "every image pinned by digest" check.
- `scripts/smoke.sh` checks both shops' catalogs, that neither shows the other's products, and the unknown-shop 404 (default `SHOP_DOMAIN=shop.localhost:8080`); it can run only once the cell is deployed.
- `CONTEXT.md`, ADRs 0010–0012, the amendments to ADRs 0004, 0006, and 0007, and the README are written.
- Left: the architecture doc (`docs/architecture/`), `make smoke` against the deployed lab cluster, and the memory measurement with the router running. The last two need both pull requests merged and synced.
