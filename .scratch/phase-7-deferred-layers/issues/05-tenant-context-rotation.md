# 05: Rotate a cell's tenant-context secret with no downtime

**What to build:** Two-key verification in the cell's units and a three-step rotation through sealed secrets; `make rotate-tenant-context CELL=…` (decision 2).

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] `verifyTenantContext` accepts a list of secrets; the storefront, catalog API, and order service read `TENANT_CONTEXT_SECRET` and an optional `TENANT_CONTEXT_SECRET_NEXT`
- [ ] The edge signs with the cell's key file and picks up a changed file without a restart
- [ ] `make rotate-tenant-context CELL=…`: add next to the cell (sealed, committed, rolled out, every pod accepting both); switch the edge to the next; make the next the only key; each step waits for its rollout
- [ ] Tests: a context signed with either key is accepted while both are set, only the new one after; Compose drill
- [ ] Cluster: dedicated-1 rotated with a probe through the ingress; zero answers that are not 200
