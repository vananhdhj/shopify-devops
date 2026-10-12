# Spec: Phase 3 — cells

**Status:** resolved (2026-10-12: tickets 01–07 resolved; PRs #27–#33 and the ticket 07 PR merged and deployed to the lab cluster)

Background: the blueprint (`~/workspace/Research/narrow/Shopify DevOps Portfolio Blueprint.md`) puts Phase 3 after the control plane: "Cells: ApplicationSet, three cells, placement by plan, fleet view, memory measurement", with the exit gate "Tenants on different cells; one cell's failure is contained; measured memory recorded." Phases 1 and 2 are resolved; ADRs 0001–0016 are binding. Lessons that shape this phase: dependencies deploy before dependents, a release that adds a Secret key needs `make secrets` against the cluster first, and local suites run with the cluster stopped.

## Problem Statement

Every shop runs in one cell. A failed database, a bad release, or a noisy shop in that cell reaches every merchant on the platform at once, and a merchant who needs isolation cannot get it. The platform has no notion of where a shop runs beyond the single value `cell-1`, no way to run more than one cell, and no view of which version each part of the fleet runs.

## Solution

Three cells in the dev environment, each a complete copy of the shop stack with its own PostgreSQL, Redis, and secrets:

- `canary`: the platform's own synthetic shop, and the first cell every release will reach (Phase 4 adds the waves).
- `pool-1`: shared by `starter` shops. The existing cell (`shop-dev` namespace, Harbor Goods and Meadow Supply) becomes `pool-1`; its data does not move.
- `dedicated-1`: one `plus` shop alone.

The control plane keeps a **cell directory** and **places** each new shop by plan. A platform-level **edge router** replaces the per-cell router: it maps a host to a tenant and that tenant's cell, and signs the tenant context with that cell's secret. Argo CD generates one Application per cell from Git through an ApplicationSet. A **fleet view** shows each cell's version, health, and shop count.

## Decisions (approved 2026-10-12)

1. **The router moves out of the cell, to a platform-level edge** (`edge-dev` namespace, its own Application). With several cells, the edge must reach whichever cell holds a shop; a per-cell router behind one wildcard Ingress cannot. The edge holds every cell's tenant-context secret, so it is the one unit trusted with all of them. Alternative: keep a router per cell and add a front proxy that only picks the cell; rejected as two hops and two components for the same decision.
2. **The existing `shop-dev` namespace becomes cell `pool-1` without moving data.** Cells are named by role; namespaces by environment and cell (`cell-canary-dev`, `cell-dedicated-1-dev`), except `pool-1`, which keeps `shop-dev` until a tenant move (Phase 6) can empty it. Alternative: migrate Harbor Goods and Meadow Supply into a new namespace now; rejected, as moving tenants is Phase 6's work.
3. **Placement:** `starter` → the pooled cell with the fewest active shops (only `pool-1` for now); `plus` → a dedicated cell with no shop; no free dedicated cell → the signup is refused with "no capacity" (no queueing). `canary` takes only shops flagged internal (the platform's synthetic shop).
4. **Per-cell secrets:** each cell's database passwords, tokens, and tenant-context secret are generated per cell, so a leak exposes one cell. Refined while writing the tickets: one file per cell, `.secrets/cells/<cell>.env`, with the same key names as today, instead of cell prefixes inside `.secrets/dev.env`; `.secrets/dev.env` keeps the platform's own keys. Pool-1's file is made by moving its keys out of `.secrets/dev.env`, values unchanged, so its running database keeps its passwords.
5. **Local development keeps one cell in Compose by default**, with an opt-in second cell (`make dev-up CELLS=2`) for the containment tests, so the default suite does not double its CPU cost.

## User Stories

1. As a merchant on the `plus` plan, my shop runs in a cell of its own; no other shop's load or failure reaches it.
2. As a merchant on the `starter` plan, my shop is placed in a pooled cell automatically at signup.
3. As a buyer, a shop in a failed cell shows "temporarily unavailable"; shops in other cells keep working.
4. As the platform operator, `make fleet` shows every cell's images, Argo CD sync and health, database and API readiness, and shop count.
5. As the platform operator, adding a cell is a pull request that adds one directory under `deploy/cells/`; Argo CD creates its Application.
6. As the platform operator, a deleted shop is purged from whichever cell held it.
7. As a reviewer, I can watch one cell's database stop while the others keep serving.

## Implementation Decisions

- **Cell directory:** `platform.cells` (id, role `canary|pooled|dedicated`, capacity in shops, storefront, catalog, and orders URLs, `registered_at`). A cell enters the directory by **registering**: once its units are healthy, a one-shot job in the cell (an Argo CD PostSync hook; a one-shot service in Compose) posts its role, capacity, and URLs to `POST /internal/cells/:id/registration`, authenticated with that cell's own `PLATFORM_CELL_TOKEN`. Only a registered cell takes new shops. The migration renames `cell-1` to `pool-1` and enters `pool-1` unregistered, so existing shops keep a valid cell.
- **Tenants:** `tenants.plan` (`starter|plus`, default `starter`) and `tenants.internal` (default false). The signup form and API take the plan.
- **Placement** happens in the signup transaction, under a lock on the candidate cells, so two signups cannot both take the last dedicated cell, and "no capacity" is a synchronous refusal (409). A shop entered without a cell (the canary's synthetic shop, from the seed) is placed by provisioning, which retries until a canary cell has registered.
- **Cell credentials:** the control plane and the edge read each cell's secrets from a directory of files, one per cell and key (`<cell>.platform-cell-token`, `<cell>.storefront-token`, `<cell>.tenant-context-secret`), mounted from a Secret in the cluster and from `.secrets/mounts/` in Compose, re-read when a cell is missing; adding a cell needs `make secrets`, never a restart. The control plane purges a shop through its own cell's URLs with its cell's token, and checks a Merchant sign-in only from the storefront token of the shop's cell, so a cell's storefront cannot ask about another cell's shops.
- **Edge router:** the Phase 1 router with the cell directory added: the routing table carries each shop's cell and every registered cell's storefront URL; the edge proxies to the shop's cell and signs with that cell's secret. Its `/tmp` routing cache and clean 503s carry over. A shop whose cell is unknown to the edge, or whose secret it lacks, gets "temporarily unavailable" (503), never another cell's page. The edge is a new Deployment of the router image in `edge-dev`, with its own Application.
- **Cells in Git:** `deploy/cells/dev/<cell>/kustomization.yaml` per cell over `deploy/base` (the router leaves the base when the edge takes over); an ApplicationSet with a Git directory generator makes one Application per directory, with `PruneLast` and the sync waves of Phase 2 ticket 06. The ApplicationSet controller is enabled in the Argo CD values. Pool-1's Application (`shop-dev` today) is replaced by the generated one without deleting its resources (orphaning delete, then adoption). The release workflow pins digests in every cell's kustomization; the canary gets its own digests in Phase 4.
- **Fleet view:** `GET /operator/cells` (directory, shop counts by status, live readiness of each cell's APIs) plus `make fleet`, which adds Argo CD sync and health and image digests per cell from the cluster.
- **Delivery, dependencies first:** the cell directory ships with pool-1 alone; the edge then runs beside the per-cell router, carrying no traffic; the ingress switches to the edge in its own release once the edge is healthy; only then do the new cells appear, since a per-cell router would serve another cell's shop from the wrong cell. No new image: the edge runs the router image.

## Testing Decisions

- Seam 1 with two cells (opt-in): placement by plan; a shop in cell B is served through the edge with cell B's context and is invisible to cell A; stopping cell A's database leaves cell B's shops serving and cell A's showing 503; deletion purges from the right cell.
- Seam 2 (lab cluster): `make smoke` across cells; a cell-outage drill; memory with three cells recorded.

## Out of Scope

- Release waves and promotion gates (Phase 4); tenant moves between cells (Phase 6); quotas and fairness (Phase 5).
