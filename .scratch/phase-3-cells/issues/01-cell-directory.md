# 01: Cell directory — the control plane knows its cells and places shops by plan

**What to build:** The registry gains a cell directory, plans, and placement. A cell registers itself once healthy; signup places each new shop by plan and refuses a `plus` shop when no dedicated cell is free; deletion purges through the shop's own cell; a Merchant sign-in is checked only for the storefront of the shop's cell. Secrets move to one file per cell. Only `pool-1` exists, in Compose and on the cluster, so nothing changes for buyers.

**Blocked by:** none

**Status:** ready-for-agent

- [ ] Migration: `platform.cells` (id, role, capacity, storefront, catalog, orders URLs, `registered_at`); `tenants.plan` and `tenants.internal`; `cell-1` renamed `pool-1`, entered unregistered; `tenants.cell` references `cells`
- [ ] `POST /internal/cells/:id/registration` (role, capacity, URLs), authenticated by that cell's own token; idempotent; an id/role change of a cell holding shops is refused
- [ ] Placement in the signup transaction: `starter` → registered pooled cell with the fewest shops under its capacity; `plus` → registered dedicated cell with no shop; none → 409 "no capacity", nothing written; internal shops → canary only, placed by provisioning (retries until a canary cell exists)
- [ ] Signup form and API take a plan (default `starter`); the routing table carries each shop's cell and the registered cells' storefront URLs
- [ ] Deletion purges through the shop's cell's URLs with that cell's token; sign-in checks refuse a storefront token from another cell
- [ ] Cell credentials read from a directory of files (`<cell>.<key>`), re-read when a cell is missing
- [ ] `make secrets`: `.secrets/cells/pool-1.env` (pool-1's keys moved out of `.secrets/dev.env`, values unchanged), `.secrets/mounts/{platform,edge}/`; `cluster-secrets.sh` writes `cell-credentials` to the control plane's namespace
- [ ] Compose: a `cell-register` one-shot for pool-1; the cluster cell gets a PostSync registration hook (inline `wget` in the existing migrations image, so no new image)
- [ ] Seam-1 tests: placement by plan (with test-only registered cells); "no capacity" refusal writes nothing; concurrent `plus` signups for one free dedicated cell place exactly one; registration refuses another cell's token; purge goes to the shop's cell; a sign-in through another cell's storefront token is refused
