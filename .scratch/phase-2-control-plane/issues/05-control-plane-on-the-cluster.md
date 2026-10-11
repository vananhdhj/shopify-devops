# 05: The control plane on the lab cluster, and the record of Phase 2

**What to build:** The control plane runs in its own `platform-dev` namespace as its own Argo CD Application, the cell's router reads it, and the repository explains it: glossary, ADRs, README, and measured evidence, including a control-plane outage drill.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] Kubernetes: `platform-dev` namespace with PostgreSQL, migration Job, `platform-api` and `platform-worker` Deployments, Secrets wiring; Argo CD Application `platform-dev`; the router in `shop-dev` in registry mode; static mode removed
- [ ] `make smoke` signs up a throwaway shop, buys from it, deletes it, and checks zero rows
- [ ] Control-plane outage drill on the cluster: with `platform-api` scaled to 0, both seeded shops serve buyers; signup fails cleanly; recovery restores signup
- [ ] `CONTEXT.md` gains Control plane, Registry, Signup, Suspended and Deleted shops; ADRs: the control plane's own database, tenants are data and cells are infrastructure, credential version in the tenant context, deletion through purge functions with verification
- [ ] README and `docs/evidence/` record signup-to-ACTIVE time, deletion verification, the outage drill, and memory with the control plane running
- [ ] Delivery checklist: `make secrets` against the cluster before the merge syncs

## Comments
