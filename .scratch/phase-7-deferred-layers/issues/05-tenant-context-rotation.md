# 05: Rotate a cell's tenant-context secret with no downtime

**What to build:** Two-key verification in the cell's units and a three-step rotation through sealed secrets; `make rotate-tenant-context CELL=…` (decision 2).

**Blocked by:** 04

**Status:** in progress (two-key verification first; the drill once it is in every wave)

- [x] `verifyTenantContext` accepts a list of secrets; the storefront, catalog API, and order service read `TENANT_CONTEXT_SECRET` and an optional `TENANT_CONTEXT_SECRET_NEXT`
- [x] The edge signs with the cell's key file and picks up a changed file without a restart
- [x] `make rotate-tenant-context CELL=…`: add next to the cell (sealed, committed, rolled out, every pod accepting both); switch the edge to the next; make the next the only key; each step waits for its rollout
- [ ] Tests: a context signed with either key is accepted while both are set, only the new one after; Compose drill
- [ ] Cluster: dedicated-1 rotated with a probe through the ingress; zero answers that are not 200

## Comments

Implementation notes, first PR (2026-10-15): what the drill needs in every wave before it starts (dependencies first).
- `verifyTenantContext(value, secrets)` takes one secret or a list (`TenantContextSecrets`); a context signed with any of them is accepted, each compared in constant time.
  - The catalog API, the order service (through service-kit's tenant hook), and the storefront (its proxy and `lib/tenant.ts`) read `TENANT_CONTEXT_SECRET` and an optional `TENANT_CONTEXT_SECRET_NEXT`.
  - The base Deployments pass the latter from `shop-secrets` with `optional: true`, so they work before any rotation and with the previous images, which ignore it.
  - Compose passes it too, empty unless a rotation set it.
- The edge already re-reads each cell's key file every 30 s (`CellCredentials`), and a mounted Secret's files change in place, so the edge switches with no restart.
- `make rotate-tenant-context CELL=… STEP=expand|switch|contract` (`scripts/rotate-tenant-context.sh`):
  1. **expand**: a new `TENANT_CONTEXT_SECRET_NEXT` in the cell's `.secrets` file, re-sealed; after the merge, the cell's catalog API, order service, and storefront are restarted to read it.
  2. **switch**: `.secrets/rotations/<cell>.tenant-context` says `switched`, so `secrets.sh` writes the edge's key file for the cell from the next secret, re-sealed; after the merge, the tool waits until the edge's mounted file holds it, plus the 30 s cache.
  3. **contract**: the next secret becomes `TENANT_CONTEXT_SECRET`, the old one and the state are dropped, re-sealed; the units are restarted.

  Each step:
  - commits only the changed sealed files, from a separate worktree of main (the working tree is never touched), and opens a pull request;
  - waits for the merge, and for the cluster's Secrets to equal the local values (`seal-secrets.py --verify`);
  - meanwhile probes the cell's shop through the ingress twice a second, and fails the step on any answer that is not 200.
- Tests: `tenant-context.test.ts`, pure. A context signed with the current or the next secret is accepted while both are set; the next one alone is refused before, the old one alone after; another cell's secret and an empty list are refused. The Compose suite runs with an unset next secret: `make test CELLS=2` with the cluster stopped, 48 files, 250 tests passed.
