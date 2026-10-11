# Phase 2 on the lab cluster: the control plane, a shop's whole life, an outage drill (ticket 05)

Recorded 2026-10-11 (times UTC) on the author's workstation: Apple M2, 16 GB RAM; Colima VM with 6
CPUs and 10 GB (9.9 GiB usable); k3d 5.9.0 running one k3s v1.35.5 server.

## Rollout, and the outage it caused

| Time (UTC) | Event |
|---|---|
| 16:25:59 | PR #22 merged (tickets 02–05). `make secrets` had already put `platform-secrets` into `platform-dev` and the new tokens into `shop-secrets`, so no pod waited for a missing key (the Phase 1 lesson held) |
| ~16:27 | Argo CD syncs `shop-dev` with the new manifests and the old images. The static tenant ConfigMap is pruned; the old router, which still reads it, starts failing. The new router waits for a control plane that is not deployed yet. **The shops are down from about here** |
| 16:29:07 | `platform-dev` Application applied (`e26ef17`, release digests already in both overlays) |
| 16:29–16:56 | `platform-dev`'s first sync hangs: its migration Job was a PreSync hook, which on a fresh namespace runs before anything else exists. The Job's ServiceAccount (`error looking up service account platform-dev/platform-db-migrate`) and the database it migrates were both missing; the Job hit its deadline and Argo CD kept waiting on it |
| 16:56:17 | PR #23 merged: the database and the Job's ServiceAccount move to sync wave -2, the migration becomes a Sync hook in wave -1, the units stay in wave 0 |
| ~16:57 | The stuck operation terminated (`status.operationState.phase: Terminating`, what `argocd app terminate-op` does) and a hard refresh requested. The new sync runs in order: `platform-db` ready, migration complete, `platform-api` and `platform-worker` up within about 30 s |
| 16:57:50 | The new router has its routing table; both shops answer 200 again. **Down about 30 minutes** (the start was not measured exactly) |
| 17:03 | `shop-dev` Synced and Healthy on the Phase 2 images, after Argo CD's retry; the bare platform address serves the signup page |

Lessons, both recorded as follow-ups below:

- **A rollout must not remove the old path before the new one runs.** The cell's manifests dropped the static tenant table in the same release that made the router depend on a control plane that did not exist yet. The control plane should have been deployed and healthy first, with the cell's switch in a later sync.
- **A PreSync hook cannot depend on anything its own Application creates.** The cell's migration has the same shape and works only because its database and ServiceAccount have existed since Phase 0; a fresh cluster would hang the same way.

## Smoke

`make smoke` passed against the cluster in about 25 s, including the new lifecycle check:

```
smoke: smoke-1791738201 ACTIVE 1 s after signup
smoke: smoke-1791738201 signed up, sold, deleted; 0 rows left in the cell
smoke: OK - both shops serve their own catalogs at shop.localhost:8080 and a Checkout at http://harbor.shop.localhost:8080 was Confirmed
```

The throwaway shop's audit trail in the registry (seconds after signup):

| Step | At | Detail |
|---|---|---|
| created (signup) | 0.00 s | |
| placed | 0.23 s | `cell-1` |
| activated | 0.24 s | |
| check_failed, check_failed | 0.26 s, 0.77 s | 404: the router had not refreshed its table yet |
| checked | 1.84 s | 200 through the router, third attempt |
| delete (operator) | 5.12 s | after the Merchant added a product and a guest's Order was Confirmed |
| purged (first pass) | 5.46 s | one row in each of the eight tenant-owned tables removed |
| deleted | 20.52 s | after the 15 s grace, a second pass found nothing; verified counts all 0 |

The smoke check also counted the eight tables directly in the cell's database afterwards: 0 rows.

## Control-plane outage drill

`make drill-control-plane-outage` (automated sync paused, `platform-api` scaled to 0, buyers' pages
requested once a second per shop for 60 s, then restored):

```
17:04:18 pausing Argo CD automated sync for platform-dev and stopping platform-api
17:05:35 during the outage (17:04:21 onwards): 120 shop pages served, 0 failed; a signup answered 500
17:05:35 restoring automated sync; waiting for platform-api
17:05:56 control plane back: a signup answered 202
drill: OK - existing shops kept serving through a 60 s control-plane outage; signups failed cleanly and recovered
```

Every buyer page of both shops was served from the router's cached routing table. A signup during
the outage failed at once with a 5xx; it is a 500 rather than a 503, because the router passes on
the failed upstream connection as a generic error (follow-up below).

## Memory

Measured at 17:07 UTC with the Compose stack stopped, as in Phases 0 and 1.

| | Phase 1 | Phase 2 |
|---|---|---|
| Colima VM used / available | 3,983 / 5,938 MiB | 3,842 / 6,079 MiB |
| k3d node container | 3,342 MiB | 3,223 MiB |
| `shop-dev` (the cell) | 234 MiB | 229 MiB |
| `platform-dev` (the control plane) | — | 108 MiB |
| Argo CD / monitoring | 399 / 1,039 MiB | 386 / 959 MiB |

Control-plane pods: `platform-db` 46 MiB, `platform-worker` 34 MiB, `platform-api` 28 MiB.

**CPU, not memory, is the constraint.** With the Compose stack running beside the cluster (as during
the day's local test runs and image builds), the VM's load average stayed at 35–45 on 6 CPUs; the
k3s node once went NotReady and evicted pods, and four local test runs had timeouts that passed
on re-run. With Compose stopped the load average fell to about 4.

## Follow-ups

- Deploy a dependency before its dependents: give the cell's switch to a new dependency its own
  release, or make the router fall back to its last known table across restarts.
- Move the cell's migration from PreSync to a Sync hook behind its database's wave, as the control
  plane's now is, so a fresh cluster cannot hang.
- The router should answer 503 (not 500) when the control plane's public listener is unreachable.
- Run local test suites with the k3d cluster stopped, or give them their own budget; the shared
  6 CPUs make both flaky.
