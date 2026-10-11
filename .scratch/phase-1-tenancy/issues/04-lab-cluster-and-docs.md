# 04: Two shops on the lab cluster, and the record of Phase 1

**What to build:** The k3d dev environment serves both shops through the router, and the repository explains the multi-tenant model: glossary, ADRs, README, and the architecture doc.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] Kubernetes: router Deployment and Service, tenant-table ConfigMap, Ingress for `*.shop.localhost` to the router, storefront no longer on the Ingress, new secrets wired
- [ ] `make smoke` checks both shops at `harbor.shop.localhost:8080` and `meadow.shop.localhost:8080`, and the unknown-shop `404`
- [ ] `CONTEXT.md` gains Tenant, Handle, Tenant context, Cell, and Platform operator, and the Merchant definition becomes per tenant
- [ ] ADRs: pooled tenancy with RLS as the isolation boundary; tenant identity from a signed router context; cross-tenant work only through narrow functions; amendments to ADR-0004 (tenant-bound Order token), ADR-0006 (role per schema, tenant per row), and ADR-0007 (token per cell, tenant from context)
- [ ] README and the architecture doc describe the router, tenancy, and the isolation suite
- [ ] Measured memory of the dev environment with the router, recorded in `docs/evidence/`

## Comments
