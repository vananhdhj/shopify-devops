# Phase 3 on the lab cluster: three cells, a cell-outage drill, memory (tickets 03, 05, 07)

Recorded 2026-10-12 (times UTC) on the author's workstation: Apple M2, 16 GB RAM; Colima VM with 6
CPUs and 10 GB (9.9 GiB usable); k3d 5.9.0 running one k3s v1.35.5 server; Argo CD v3.5.4.

## The fleet

`make fleet` after the release of ticket 06 (`0a30065`):

```
CELL         ROLE       PLACED/CAP  ACTIVE  PROVISIONING  SUSPENDED  DELETING  DELETED  CATALOG  ORDERS
canary       canary     1/5         1       0             0          0         0        ready    ready
dedicated-1  dedicated  1/1         1       0             0          0         0        ready    ready
pool-1       pooled     4/100       4       0             0          0         5        ready    ready

APPLICATION           SYNC    HEALTH   REVISION
cell-canary-dev       Synced  Healthy  0a30065
cell-dedicated-1-dev  Synced  Healthy  0a30065
cell-pool-1-dev       Synced  Healthy  0a30065
edge-dev              Synced  Healthy  0a30065
platform-dev          Synced  Healthy  0a30065

IMAGE             cell-canary-dev         cell-dedicated-1-dev    cell-pool-1-dev         edge-dev      platform-dev
catalog-cart-api  b5f27074747a            b5f27074747a            b5f27074747a            -             -
db-migrations     8731e717dfd1            8731e717dfd1            8731e717dfd1            -             8731e717dfd1
order-service     285a6b63a8bb            285a6b63a8bb            285a6b63a8bb            -             -
platform          -                       -                       -                       -             7a2324ead8a7
postgres          18-alpine@77f585114c32  18-alpine@77f585114c32  18-alpine@77f585114c32  -             18-alpine@77f585114c32
redis             8-alpine@3811787313eb   8-alpine@3811787313eb   8-alpine@3811787313eb   -             -
router            -                       -                       -                       f1979fa63944  -
storefront        c92621aed678            c92621aed678            c92621aed678            -             -
worker            7b452c69f945            7b452c69f945            7b452c69f945            -             -
```

Tenants on different cells: Harbor Goods, Meadow Supply, and the starter shops in `pool-1`; the
platform's synthetic shop `canary` in the canary cell; the plus shop `plus-a2d37b` alone in
`dedicated-1`. A second plus signup was refused with 409 `no_capacity`. A Checkout was Confirmed in
each cell, and `make smoke` passed (pool-1).

## How the cells arrived

| Release | What changed on the cluster | Buyer-facing effect |
|---|---|---|
| #29 (ticket 03) | The ingress switched from pool-1's router to the edge, both Ingresses serving for about 50 s, the old one pruned last | No failed request across the switch; the digest commit's image rollout cost about 19 s of intermittent errors (single replicas) |
| #30 (ticket 03a) | Probes for a slow node (ADR-0017) | Failures under CPU starvation fell from 24% to 1.3% of requests |
| #32 (ticket 05) | `shop-dev`'s Application deleted without its resources; the `cells-dev` ApplicationSet adopted pool-1 in place and created the canary and dedicated-1 cells | pool-1's database and Redis kept their pods and data. Two cells starting at once, with every unit rolling to new digests, saturated the node: 90 of 422 probe requests failed over 10 minutes, the longest outage 48.5 s; third-party pods on default probes restarted, ours did not |

The rollout lesson: add cells to a live node one at a time, and not together with an image rollout.

## Cell-outage drill

`make drill-cell-outage CELL=dedicated-1`: the cell's automated sync paused (the ApplicationSet
leaves that field alone), its PostgreSQL scaled to 0, the cell's shop and one shop in every other
cell requested once a second for 60 s, then the database and the sync restored:

```
15:58:33 dedicated-1's shop: plus-a2d37b; other cells' shops: canary harbor
15:58:34 pausing automated sync of cell-dedicated-1-dev and stopping dedicated-1's PostgreSQL
15:58:35 dedicated-1's PostgreSQL is down
15:58:36 plus-a2d37b answers 500
16:00:04 during the outage: plus-a2d37b answered 500; other cells served 120 pages, failed 0
16:00:04 restoring dedicated-1's PostgreSQL and automated sync
16:00:09 plus-a2d37b answers 200 again
16:00:13 cell-dedicated-1-dev: Synced Healthy, automated sync {"prune":true,"selfHeal":true}
drill: OK - dedicated-1's shop failed 1 s after its database stopped and recovered 5 s after the restore; other cells (canary harbor) served all 120 pages
```

The failure stayed in its cell. The plus shop failed within a second; the canary's and Harbor
Goods' pages were all served; the shop recovered 5 s after its database was scaled back up, and
the cell's Application returned to automated sync, Synced and Healthy.

The failed shop answered **500, not the edge's 503 "temporarily unavailable"**: the cell's
storefront is up, its page fails because the catalog API is not ready, and a Next.js page cannot
choose a 503. The edge answers 503 only when a cell's storefront itself is unreachable (checked
locally by the containment tests: dedicated-1's storefront stopped, its shop gets the edge's 503 and
Harbor Goods 200). Follow-up below. Run with the VM quiet (load average under 2 before the drill).

## Memory

Measured at 15:58 UTC with three cells, the Compose stack stopped, as in Phases 0–2.

| | Phase 2 | Phase 3 |
|---|---|---|
| Colima VM used / available | 3,842 / 6,079 MiB | 4,518 / 5,404 MiB |
| k3d node container | 3,223 MiB | 3,683 MiB |
| Cells | `shop-dev` 229 MiB (with its router) | `pool-1` (`shop-dev`) 170, `canary` 171, `dedicated-1` 169 MiB |
| Edge router (`edge-dev`) | — (in the cell) | 34 MiB |
| `platform-dev` (the control plane) | 108 MiB | 88 MiB |
| Argo CD / monitoring | 386 / 959 MiB | 514 / 940 MiB |

A cell costs about 170 MiB: storefront 46, worker 36, PostgreSQL 31, catalog API 26, order service
26, Redis 6. Two more cells cost the VM about 680 MiB in all (cells, the ApplicationSet controller,
and Argo CD tracking three Applications more). At this rate the VM has room for many more cells by
memory.

**The constraint is the host, not the VM.** With three cells the VM kept 5.4 GB available, yet
during the afternoon its load average sat at 25–30 on 6 CPUs while the 16 GB host had under 100 MB
free and about 8 GB compressed (the browser held about 11 GB). Host memory compression slows the
VM's CPUs. Once the host's memory was freed, the VM's load fell under 2 and the drill ran clean.

## Follow-ups

- A shop whose cell's APIs are down should answer 503 "temporarily unavailable" rather than the
  storefront's 500: the storefront needs to tell a backend outage from its own bug (for example a
  route-level handler in front of the pages), without hiding real 500s from the error-ratio alert.
- Zero-downtime rollouts for Phase 4's waves: a preStop delay on every unit, and a second edge
  replica.
- Third-party charts (coredns, Argo CD, the monitoring stack) still use default probes and restart
  under CPU starvation; give them ADR-0017's settings.
- Adding cells: one at a time, and not together with an image rollout.
