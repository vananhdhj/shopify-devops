# 05: Releases reach wave 0 only

**What to build:** The switch. The release workflow pins new digests in wave 0's cells, the control plane, and the edge only; waves 1 and 2 get a release only through the promoter. A new unit's first digest still goes into every cell.

**Blocked by:** 01, 04 (deployed and healthy on the cluster)

**Status:** resolved

- [ ] `release.yml`: overlays from the cells whose `cell.json` has `wave: 0`, plus the control plane and the edge; an image missing from a cell is added to every cell
- [ ] README: the release path (merge → wave 0 → soak and gate → wave 1 → wave 2), the manual `promote` fallback, how to read `make fleet`
- [ ] Cluster: a normal release promoted through waves 0 → 1 → 2 with no human step; timings from merge to each wave in the ticket

## Comments

Implementation notes (2026-10-13):
- `release.yml`'s `deploy-dev` reads every dev cell's `cell.json` and pins the new digests in the wave 0 cells (the canary), the control plane, and the edge only. It fails if no cell is in wave 0.
- An image no overlay lists yet, a new unit's first build, is added to every cell at once, whatever its wave, because every cell's manifests share the base and reference it from the merge. Before, it went to pool-1 only.
- The README's delivery path describes the waves, the promoter's gate, a halt and its revert, the manual `promote` fallback, and the rule this switch makes sharper: manifests reach every wave at the merge, only image digests move by wave, so a manifest must work with the previous release's images.
- Tested the new step in an Alpine container (bash, yq, jq) on a copy of the overlays. A new storefront digest went to the canary only (pool-1 and dedicated-1 unchanged), and a new unit's first digest went to all three cells.
- This PR's own merge is the first release through the waves: `.github/` counts as shared in `.github/path-filters.yml`, so it rebuilds every image, and its `release.yml` pins them in wave 0 only.

Resolved 2026-10-13 with PR #42 (`045442c`). Its own merge was the first release through the waves (every image rebuilt). Times are UTC, from the promoter's records and the Argo CD Applications:

| Time | Event |
|---|---|
| 21:12:39 | #42 merged |
| 21:14:12 | Digest commit `da06844`: the canary, the control plane, and the edge only (pool-1 and dedicated-1 unchanged) |
| 21:16:54 | Canary rolled, Synced and Healthy |
| 21:17:13 | Wave 0 soak started (canary) |
| ~21:22 | Gate passed. The dispatch was refused, GitHub answered 403 "Resource not accessible by personal access token": the token had Actions read, not write. The promoter retried every tick, and the release stayed in the canary |
| 21:36:31 | Token fixed (Actions: read and write), `make secrets`, promoter restarted. On its first tick it dispatched `promote` for wave 1: "soaked 1156 s in wave 0 (canary), 76 ticks, synthetic Checkouts {"canary":76}" |
| 21:36:46 | `promote` committed `4e03007` "promote to wave 1 (pool-1)" (run 38311685478) |
| 21:38:15 | pool-1 synced; wave 0's promotion marked promoted; wave 1 soak started |
| 21:43:30 | Wave 1 gate passed ("soaked 313 s in wave 1 (pool-1), 21 ticks, synthetic Checkouts {"pool-1":22}"); `promote` dispatched for wave 2 |
| 21:44:04 | `promote` committed `d7ce36c` "promote to wave 2 (dedicated-1)" (run 38312403732) |
| 21:45:00 | dedicated-1 runs the release; wave 1's promotion marked promoted |

- `make fleet` afterwards showed one digest per unit across all three cells.
- Without the token's 14-minute stall, merge to the last wave took about 18 minutes: two 5-minute soaks plus build, sync, and rollouts.
- Probes through the ingress, every 250 ms from 21:13 to 21:53, about 6,600 requests per shop:
  - `canary`: one 500 as it rolled (21:16:53);
  - `plus-a2d37b` (dedicated-1): one 503 as it rolled (21:44:49), and one 2 s timeout at 21:44:18;
  - `harbor` (pool-1): only that same 2 s timeout.
  These single requests do not fail the gate: a check must fail on two ticks in a row, and the ratio is over 2 minutes. A zero-error rollout is still not quite reached; recorded for ticket 07's evidence.
- Each wave first recorded a short-lived soak while its cell was still rolling (a mix of old and new images), superseded 15 s later: promotions 1 and 3. Nothing was dispatched for them. Fixed in #43: only a wave whose cells are all Synced and Healthy is soaked.
