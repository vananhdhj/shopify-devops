# 01: Cell directory — the control plane knows its cells and places shops by plan

**What to build:** The registry gains a cell directory, plans, and placement. A cell registers itself once healthy; signup places each new shop by plan and refuses a `plus` shop when no dedicated cell is free; deletion purges through the shop's own cell; a Merchant sign-in is checked only for the storefront of the shop's cell. Secrets move to one file per cell. Only `pool-1` exists, in Compose and on the cluster, so nothing changes for buyers.

**Blocked by:** none

**Status:** in review

- [ ] Migration: `platform.cells` (id, role, capacity, storefront, catalog, orders URLs, `registered_at`); `tenants.plan` and `tenants.internal`; `cell-1` renamed `pool-1`, entered unregistered; `tenants.cell` references `cells`
- [ ] `POST /internal/cells/:id/registration` (role, capacity, URLs), authenticated by that cell's own token; idempotent; an id/role change of a cell holding shops is refused
- [ ] Placement in the signup transaction: `starter` → registered pooled cell with the fewest shops under its capacity; `plus` → registered dedicated cell with no shop; none → 409 "no capacity", nothing written; internal shops → canary only, placed by provisioning (retries until a canary cell exists)
- [ ] Signup form and API take a plan (default `starter`); the routing table carries each shop's cell and the registered cells' storefront URLs
- [ ] Deletion purges through the shop's cell's URLs with that cell's token; sign-in checks refuse a storefront token from another cell
- [ ] Cell credentials read from a directory of files (`<cell>.<key>`), re-read when a cell is missing
- [ ] `make secrets`: `.secrets/cells/pool-1.env` (pool-1's keys moved out of `.secrets/dev.env`, values unchanged), `.secrets/mounts/{platform,edge}/`; `cluster-secrets.sh` writes `cell-credentials` to the control plane's namespace
- [ ] Compose: a `cell-register` one-shot for pool-1; the cluster cell gets a PostSync registration hook (inline `wget` in the existing migrations image, so no new image)
- [ ] Seam-1 tests: placement by plan (with test-only registered cells); "no capacity" refusal writes nothing; concurrent `plus` signups for one free dedicated cell place exactly one; registration refuses another cell's token; purge goes to the shop's cell; a sign-in through another cell's storefront token is refused

## Comments

Implementation notes (2026-10-12):
- `platform.cells` with role, capacity (a dedicated cell's is 1, by check constraint), URLs, and `registered_at`; only registered cells take shops. The migration enters `pool-1` unregistered and renames every `cell-1` shop, then adds the foreign key. Audit events default to `clock_timestamp()`, since signup now writes two (`created`, `placed`) in one transaction.
- Placement (`apps/platform/src/cells.ts`) locks every registered cell of the role with `FOR UPDATE`, counts the shops not yet deleted, and picks the emptiest with room. Signup runs it in its own transaction; "no capacity" rolls the whole transaction back (409 `no_capacity`). Provisioning places only a shop entered without a cell, retrying with backoff until a cell of its role registers.
- Registration is `POST /internal/cells/:id/registration`, authenticated by the file `<id>.platform-cell-token`, so a cell the control plane holds no secrets for cannot register. Registering again is the normal case (every sync). It refuses a role change while the cell holds shops, and a capacity below its shops.
- Cell credentials (`@shop/tenancy` `CellCredentials`): one file per cell and key, cached 30 s, a missing file looked for again after 1 s, so `make secrets` adds a cell without a restart.
- Secrets: `.secrets/cells/pool-1.env` gets pool-1's twelve keys moved out of `.secrets/dev.env`, values unchanged (checked against a backup); `.secrets/mounts/{platform,edge}/` are rendered from the cell files. On the cluster, `platform-secrets` keeps pool-1's cell and storefront tokens until ticket 03, so the release before this one can still start.
- The cell registers itself with a PostSync hook (`deploy/base/jobs/register-cell.yaml`) that runs `wget` from the already-pinned migrations image (no new image), reading `CELL_ID`, `CELL_ROLE`, `CELL_CAPACITY` from `shop-env`. In Compose a `cell-register` one-shot does the same before the router starts.
- A Merchant sign-in check for a shop no cell holds now answers 401, since no storefront's token can be that of its cell.

Rollout (dependencies first): `make secrets` against the cluster before the merge (creates `cell-credentials` in `platform-dev`; the platform pods mount it). After the digest commit, `platform-dev` migrates and rolls out, and `shop-dev`'s PostSync hook registers pool-1, retrying until the new platform-api answers. Until then signups answer `no_capacity`, which is a window of about one sync.

`make test` passes locally (31 files, 178 tests) in 277 s with the k3d cluster stopped. New tests (`cells.test.ts`): registration refuses a missing, wrong, or other cell's token and a role or capacity change that would strand shops; a starter shop lands in pool-1; a plus shop is refused with nothing written when no dedicated cell is free, takes a free one and is served, and only one of six racing plus signups wins the last one; an internal shop waits until a canary cell registers; a deletion waits on an unreachable cell API and finishes once the cell registers a reachable one; a sign-in check with another cell's storefront token is refused.
