# 06: Hardening after the Phase 2 rollout

**What to build:** The four follow-ups from `docs/evidence/2026-10-11-phase-2-cluster.md`, before Phase 3 multiplies cells. Each one either caused part of the ~30-minute outage of the Phase 2 rollout or would cause the same in every new cell.

**Blocked by:** 05

**Status:** resolved

- [x] The cell's migration is a Sync hook behind its database (sync waves), as the control plane's is since #23, so a fresh cell's first sync cannot hang
- [x] Both Argo CD Applications prune last (`PruneLast=true`): a resource the old pods still use is removed only after the new ones are healthy. In the outage, the old router died because its tenant ConfigMap was pruned before the new router could be ready
- [x] The router keeps its last routing table in its pod (`/tmp`), so a router container that restarts while the control plane is down comes back ready on that table instead of unready
- [x] The router answers 503 with a fixed body, not 500, when the storefront or the control plane's signup listener is unreachable
- [x] `make test` warns when the k3d cluster is running beside the Compose stack (the cause of the load-related test failures)
- [x] Seam-1 tests: with `platform-api` stopped, a signup at the bare domain answers 503; a router restarted while `platform-api` is stopped is ready and serves both shops

## Comments

Implementation notes (2026-10-12):
- The cell's PostgreSQL, Redis, and the migration's ServiceAccount are in sync wave -2; the migration is a Sync hook in wave -1; the units stay in wave 0. The dev seed stays a PostSync hook.
- `PruneLast=true` is set on both Applications. They are not managed by Argo CD, so they need one `kubectl apply` after the merge (`make bootstrap-gitops` does it on a fresh cluster).
- The router saves each good routing table to `/tmp/routing-table.json` (write then rename) and, when its first refresh fails, starts on that copy with a warning. `/tmp` is the pod's emptyDir, so the copy survives container restarts, not pod replacement: a new pod still needs the control plane.
- Upstream failures (storefront or signup listener) answer 503 with `Retry-After` and a fixed body through `reply-from`'s `onError`; the reason goes to the log.
- `scripts/warn-cluster-running.sh` runs first in `make test`.

Resolved 2026-10-12. `make test` passes (30 files, 169 tests) in 350 s with the k3d cluster stopped (it took about 680 s with the cluster running). New tests: with `platform-api` stopped, a signup at the platform address answers 503 with the fixed body; a router restarted while `platform-api` is stopped comes back ready on its saved table and serves both shops.
