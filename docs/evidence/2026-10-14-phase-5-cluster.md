# Phase 5 on the lab cluster: per-tenant limits, the tenant dimension, the noisy-neighbour experiment (tickets 01–08)

Recorded 2026-10-13/14 (times UTC) on the author's workstation: Apple M2, 16 GB RAM; Colima VM with 6
CPUs and **8 GB** (10 GB until 2026-10-13 19:06, see below); k3d 5.9.0 running one k3s v1.35.5
server; Argo CD v3.5.4. Cells: `canary` (wave 0), `pool-1` (wave 1, at most 20 shops),
`dedicated-1` (wave 2).

## Exit gate: the noisy-neighbour experiment

`make experiment-noisy-neighbour`. k6 1.3.0 runs in a container on the k3d network, through the
ingress by Host header (`tests/load/noisy-neighbour.js`), against four starter shops in pool-1:
- three quiet shops each run one buyer journey a second (home page, add to cart, Checkout page, Checkout with the decline scenario): four requests a second, under their plan's 10;
- after a 5-minute baseline, the noisy shop is driven at 100 requests a second (10× its rate quota) for 5 minutes, home pages and Cart adds;
- the VM's load is sampled every 10 s, and a run with a sample over 12 is void.

Run of 2026-10-13: k6 from about 20:02:30 (its container took a few minutes to start). Baseline to 20:07:30, noise to 20:12:30. The VM's load peaked at 2.2.

| Shop | Checkout p95, baseline | Checkout p95, with the noise | Checkouts (baseline + noise) | Failed journeys |
|---|---|---|---|---|
| nn-quiet-1 | 22 ms | 15 ms | 301 + 301 | 0 |
| nn-quiet-2 | 23 ms | 18 ms | 301 + 301 | 0 |
| nn-quiet-3 | 22 ms | 18 ms | 300 + 301 | 0 |

| Noisy shop's answers | Count |
|---|---|
| 429 (rate quota) | 26,976 |
| 2xx | 2,248 |
| 5xx | **0** |
| no answer | 0 |

**The bound is met.** The noisy shop got 429s and no 5xx. Every quiet shop's Checkout p95 stayed within 20% of its baseline; it was in fact lower during the noise, by 20–29%. That is most likely the baseline's first minutes warming the cell up, not the noise making anything faster. The run shows no slowdown; it does not show a speed-up.

Through the edge's metrics (`router_requests_total{tenant_id}`), the noisy shop's 100 requests a second during the noise split into about 90 a second answered 429 and about 10 let through (8 × 2xx, 2 × 3xx a second): exactly its quota. Its burst of 30 was spent at the start.

## The dashboards, with that traffic

Grafana has the four dashboards from `deploy/monitoring/config/dashboards`: Fleet, Cell, Tenant, Control plane. Their queries for the experiment's window return:
- the Tenant dashboard's rate-quota panel (`router_rate_limited_total` joined to `tenant_info{tenant="nn-noisy-…"}`): 21 a second at 20:08 over 2 minutes, and about 90 a second over the full minutes after;
- the Tenant dashboard's Checkout p95 (accepted) for the three quiet shops: 11 to 14 ms;
- the Fleet dashboard's requests per cell: pool-1 at 32 a second, canary and dedicated-1 at 0.12 a second (their synthetic Checkouts);
- the synthetic Checkout counts per cell: canary, pool-1, and dedicated-1 each about one passed a minute. A round waits for every Order to settle before its 30 s pause, so "every 30 s" is in practice about once a minute per cell.

## Phase 5's releases through the waves

Every ticket went canary, then pool-1, then dedicated-1, with no human step:
- #49 (`plan` in the tenant context), #50 (rate quota), #51 (Checkout cap), #52 (fair dispatch), #53 (product quota), #54 + #55 (metrics and dashboards), #56 (the fix below).
- The last one, the first after #54's rule that a soak starts only after two ticks of the same release: canary soaked 18:29:47, promoted 19:09:55 (the cluster was down for the Colima restart in between); pool-1 promoted 19:18:25. No superseded soak.

## What broke, and what held

- **#54's cell label stopped every cell's sync.** Kustomize's `labels` transformer with `includeTemplates` also writes into a StatefulSet's `volumeClaimTemplates`, which cannot change. Every cell Application failed with `StatefulSet.apps "postgres" is invalid: spec: Forbidden` from about 16:45 until #56 (merged 18:13), which patches the label into pod templates only. The cells stayed Healthy on the previous release throughout. CI's render and schema checks cannot see this; only applying to an existing StatefulSet does.
- **The promote workflow's guard refused a mixed release** (#53's release, 15:45). With the cluster stopped for a local test run, the promoter re-dispatched #53's wave 1 promotion every 10 minutes. When pool-1 came back, Argo CD briefly listed the previous release's migration-job image beside the new digests, and the promoter soaked that set as a release. The dispatch for wave 2 failed: "wave 1 does not run exactly these digests". A minute later the true release settled, was soaked (20 ticks), and reached dedicated-1 at 15:54. Nothing wrong was deployed.
- **The host.** The 16 GB laptop ran out of memory several times (under 150 MB free, about 8 GB compressed). Each time, coredns crash-looped and Argo CD could not resolve its repo server; once, Colima's Docker stopped answering and a local test run hung for 30 minutes. Colima was restarted twice with the author's agreement, the second time at 8 GB instead of 10 (the VM used about 4.5 GB). The experiment ran once the author had closed the browser's heaviest tabs.

## Memory

Measured at 20:29 with three cells, the promoter, and the four dashboards; the Compose stack stopped.

| | Phase 4 (10 GB VM) | Phase 5 (8 GB VM) |
|---|---|---|
| Colima VM used / available | 4,533 / 5,389 MiB | 4,366 / 3,556 MiB |
| k3d node | 3,802 MiB | 5,182 MiB |
| Cells (pool-1, canary, dedicated-1) | 230, 227, 219 MiB | 255, 253, 257 MiB |
| Edge | 45 MiB | 48 MiB |
| `platform-dev` | 143 MiB | 208 MiB |
| Argo CD / monitoring | 411 / 933 MiB | 685 / 1,332 MiB |
| kube-system | 93 MiB | 342 MiB |

Monitoring grew by about 400 MiB with the tenant and cell series and the recording rules. Argo CD and kube-system grew after the restarts, and were measured an hour after the last one. The VM still has 3.5 GB to spare; the laptop's memory remains the lab's limit.

## Follow-ups

- Per-tenant limits are per process: exact with one replica of each unit, N times the limit with N (ADR-0026).
- The synthetic prober's interval should be counted from each round's start, so a cell is checked every 30 s whatever its rounds take.
- A check that applies the rendered cell manifests to a scratch cluster in CI would have caught #54's StatefulSet error before merge.
- From Phase 4: an alert for a release stuck unsettled in wave 0; a second edge replica.
