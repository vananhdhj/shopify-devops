# 05: Rotate a cell's tenant-context secret with no downtime

**What to build:** Two-key verification in the cell's units and a three-step rotation through sealed secrets; `make rotate-tenant-context CELL=…` (decision 2).

**Blocked by:** 04

**Status:** resolved

- [x] `verifyTenantContext` accepts a list of secrets; the storefront, catalog API, and order service read `TENANT_CONTEXT_SECRET` and an optional `TENANT_CONTEXT_SECRET_NEXT`
- [x] The edge signs with the cell's key file and picks up a changed file without a restart
- [x] `make rotate-tenant-context CELL=…`: add next to the cell (sealed, committed, rolled out, every pod accepting both); switch the edge to the next; make the next the only key; each step waits for its rollout
- [x] Tests: a context signed with either key is accepted while both are set, only the new one after; Compose drill
- [x] Cluster: dedicated-1 rotated with a probe through the ingress; zero answers that are not 200

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

The drill on dedicated-1, step by step (2026-10-14/15):
- **expand** (PR #77, the cell's re-sealed `shop-secrets` with a next secret): merged 22:27 UTC. The cluster's Secret held the step at about 22:44 (13 keys, equal to the local values), and the catalog API, order service, and storefront were restarted on it by 22:46.
  - The probe failed the step: 130 of 459 requests. All the failures it showed were timeouts (no answer within 5 s), not refusals. The VM's load was at 34 because the new autoscalers had tripled pool-1's storefront and catalog API (ticket 06), which also slowed the controller's apply.
  - The first probe reported a timeout as `000` and deleted its log on exit. It now records `timeout` apart from refusals and keeps each step's log in `.local/`.
  - An expand only adds an accepted key, so nothing in it can refuse a request; switch and contract are the steps that can.
- **switch** (PR #80, the edge's re-sealed `cell-credentials`): the probe ran from 23:51 UTC, before the merge.
  - Merged 00:24:40; the cluster's Secrets held the step at 00:25:14; the edge's mounted file held the next secret and the edge signed with it from 00:26:20 (its 30 s cache), with no restart.
  - From the merge on, 1,039 requests, none refused, none timed out.
  - Over the whole window, 3,544 requests, none refused, and one timeout at 00:08:16, 16 minutes before the merge. The tool counts the whole window, so it reported the step as failed on that timeout.
- **contract** (PR #81, the cell's re-sealed `shop-secrets`: the next secret as `TENANT_CONTEXT_SECRET`, the old one gone): merged 00:34:54; held at 00:37:10; the three units restarted by 00:37:20.
  - 926 requests over the window, none refused, and one timeout at 00:36:10, while the controller was applying the step, before any restart, with the VM's load near 13.
- **The end state.** dedicated-1's `.secrets` file and its Secret hold one `TENANT_CONTEXT_SECRET`, whose hash (`c5834c676a21`) equals the edge's mounted key for dedicated-1. No unit has a `TENANT_CONTEXT_SECRET_NEXT`, no rotation state is left, and the shop answers 200.

Resolved 2026-10-15 with PRs #75 (two-key verification; through the waves, dedicated-1 at 22:13 UTC) and #77, #80, #81 (the drill). **No request was refused in any step.** The timeouts (130 in expand while pool-1's autoscalers had tripled it; 1 before the switch's merge; 1 during contract's apply) came from the host, not the rotation: every one was a missing answer within 5 s, none a 4xx or 5xx.

Follow-ups:
- the tool could count only from the merge on;
- local `main` cannot fast-forward over the files a step re-sealed (the same content as the merged PR): restore them and fast-forward.

