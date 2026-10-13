# Phase 4 on the lab cluster: releases in waves, a bad release halted at the canary (tickets 01–07)

Recorded 2026-10-12/13 (times UTC) on the author's workstation: Apple M2, 16 GB RAM; Colima VM with 6
CPUs and 10 GB; k3d 5.9.0 running one k3s v1.35.5 server; Argo CD v3.5.4. Three cells: `canary`
(wave 0), `pool-1` (wave 1), `dedicated-1` (wave 2). The control plane and the edge go with wave 0.

## Exit gate: a bad release halts at wave 0, a Git revert restores the canary

The drill release (#45) made every Checkout fail with 500 wherever `KUBERNETES_SERVICE_HOST` is set:
in any Kubernetes pod, never in CI's Compose stack. It passed every pull-request check, the
`compat` job and both integration runs included. Only the order-service image changed.

| Time | Event |
|---|---|
| 00:20:06 | #45 merged (`02916a9`) |
| ~00:21:20 | Digest commit `1cd50b1`: the new order-service digest in `deploy/cells/dev/canary` only |
| 00:24:06–36 | Canary rolled; Synced and Healthy |
| 00:24:20 | Wave 0 soak started (promotion 8) |
| **00:25:09** | **Halted** after 49 s: the canary's synthetic Checkout failed on two ticks in a row. Exposed cells: `canary`. **Exposed tenants: 0** (the canary holds only its synthetic shop) |
| 00:25:32 | `PromotionHalted` firing |
| 00:25:46 | Received by the in-cluster alert catcher (Discord is on the same route) |
| 00:54:27 | Revert merged (#46, `38d4adb`) |
| 00:57:02 | `PromotionHalted` resolved, as soon as the canary ran the reverted release (catcher 00:57:21) |
| 00:57:32 | Wave 0 soak of the reverted release |
| 01:03:43 | Gate passed (364 s, 5 ticks, 5 synthetic Checkouts); `promote` dispatched for wave 1 |
| 01:06:31 | pool-1 runs it; wave 1 soak |
| 01:22:44 | Gate passed (970 s, 21 ticks, 22 synthetic Checkouts); `promote` dispatched for wave 2 |
| 01:25:44 | dedicated-1 runs it: every cell on order-service `7d7c05f4c29b` |

While the release was halted, `make fleet` showed the bad order-service digest (`2fba0af2f006`)
in the canary only; pool-1 and dedicated-1 ran `da196965e0bd` throughout. Probes of a shop in
each cell (Harbor Goods in pool-1, the canary's shop, the plus shop in dedicated-1), every 250 ms
from 23:58:55 to 02:10, saw **no 5xx at all**: the bad release broke Checkout, not page views,
and only in the canary. About 3% of their requests (211–219 of ~7,000 per shop) got no answer
within the probe's 2 s timeout. These were spread evenly over all three shops from before the
drill to after it, the longest stretch 71–73 s from 00:14:55, five minutes before the merge, on
all three shops at once: the host stalling the node, not the release.

## Normal releases through the waves

| Release | Merge → wave 0 soak | Wave 0 gate | Wave 1 soak → gate | Wave 2 runs it | Merge → last wave |
|---|---|---|---|---|---|
| #42 (first, every image) | 21:12:39 → 21:17:13 | ~21:22, dispatch refused (token, below), sent 21:36:31 | 21:38:15 → 21:43:30 | 21:45:00 | 32 min (18 min without the 14-minute token stall) |
| #44 (every image) | cluster down 23:27–23:40 (stopped for local tests), soak 23:42:10 | 23:47:19 | 23:49:34 → 23:54:48 | 23:57:51 | 32 min (16 min from the canary's soak) |
| #46 (the revert) | 00:54:27 → 00:57:32 | 01:03:43 | 01:06:31 → 01:22:44 | 01:25:44 | 31 min |

- Each promotion is a commit by the deploy key (`deploy(dev): promote to wave <n> (<cell>)`): runs 38311685478, 38312403732, 38323951231, 38324588747, 38330304881, 38331843074.
- A soak lasts at least 5 minutes. On a slow host it lasts longer, because each tick waits for its Prometheus queries and the synthetic Checkout; pool-1's soak of the revert took 970 s.
- **The token stall.** The first release's gate passed at about 21:22, but GitHub answered 403 to the dispatch: the fine-grained token had *Actions: read*. The release waited safely in the canary, the promoter retrying every tick. After the author gave the token *Actions: read and write*, `make secrets` and a promoter restart dispatched it on the first tick.
- **Spurious soaks.** In the first release the promoter twice started a soak while a cell was still rolling (a mix of two releases), superseded it 15 s later, and dispatched nothing for it. #43 restricts soaking to settled waves. One more appeared at 23:41, right after the cluster restart, from Argo CD's stale status.

## Rollouts

Ticket 01 (a surge-first rollout and a 5 s `preStop` delay on every served unit):
- **Restarts.** During a restart of every Deployment, plus a real image rollout, Prometheus recorded zero 5xx in any namespace (about 1,250 requests through the edge). Before, one image rollout cost about 19 s of 502/000/500.
- **The first wave release.** The probes saw one 500 as the canary rolled, one 503 as dedicated-1 rolled, and a single 2 s timeout in each of two shops (about 6,600 requests per shop over 40 minutes). A rollout with no failed request at all is not quite reached; single failures do not trip the gate, which needs two failing ticks.

## Mixed versions

- The `compat` job runs the last wave's cell images, pinned on `main` and pulled from GHCR, against each pull request's migrations, control plane, and edge, then a shop's whole life through the edge.
- The migration check refuses destructive statements unless they are marked as a contract step (ADR-0021).
- Proven locally:
  - an unmarked `RENAME COLUMN name TO title` on `catalog.products` was refused;
  - marked, the previous catalog API answered 500 (`column "name" … does not exist`) and `compat` failed.

## Memory

Measured at 01:26 with three cells, the promoter running, and the Compose stack stopped.

| | Phase 3 | Phase 4 |
|---|---|---|
| Colima VM used / available | 4,518 / 5,404 MiB | 4,533 / 5,389 MiB |
| k3d node | 3,683 MiB | 3,802 MiB |
| Cells (pool-1, canary, dedicated-1) | 170, 171, 169 MiB | 230, 227, 219 MiB |
| Edge router | 34 MiB | 45 MiB |
| `platform-dev` | 88 MiB | 143 MiB (the promoter 40) |
| Argo CD / monitoring | 514 / 940 MiB | 411 / 933 MiB |

The cells were measured after about two hours of a synthetic Checkout every 15 s in the soaking wave, against an idle Phase 3 measurement. The extra ~55 MiB per cell is the units under load (storefront, APIs, worker), not new units. The VM's available memory is unchanged; the constraint remains the host (under 150 MB free most of the session, about 8 GB compressed).

## Follow-ups

- An alert for a release that never settles in wave 0 (a cell stuck Progressing is never soaked, so never promoted, silently).
- Check a new promote token by dispatching a harmless workflow at setup: the permission stalled the first release.
- Rollouts with no failed request at all: a second replica for the edge and the storefront.
- ADR-0017's probe settings for the remaining third-party pods (coredns, Traefik, metrics-server, the monitoring stack), which restart under host pressure.
- From Phase 3: a 503 page, not the storefront's 500, for a shop whose cell's APIs are down.
