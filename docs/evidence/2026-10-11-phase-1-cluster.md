# Phase 1 on the lab cluster: two shops, smoke, and memory (ticket 04)

Recorded 2026-10-11 on the author's workstation: Apple M2, 16 GB RAM; Colima VM with 6 CPUs and
10 GB (9.9 GiB usable); k3d 5.9.0 running one k3s v1.35.5 server. The Compose stack was stopped.

## Rollout

| Time (UTC) | Event |
|---|---|
| 10:15:20 | PR #18 merged (ticket 01, the router) |
| 10:17:28 | `697bed1`: the release job adds the router image to the dev overlay (its first digest, appended because the overlay had no entry for it) |
| 10:37:20 | PR #19 merged (tickets 02–04): tenant key and row-level security, two shops, Kubernetes wiring |
| 10:39:40 | `ea54a10`: the release job pins the Phase 1 images; Argo CD syncs them, the database migration (PreSync) runs |
| 10:39–10:49 | The new storefront pod cannot start: the cluster's Secret lacks `MERCHANT_CREDENTIALS` (below). The previous storefront pod stays up, but it predates tenancy and does not forward the tenant context, so shop pages fail through this window (not measured) |
| ~10:49 | `make secrets` applies the missing key; the storefront starts |
| ~10:50 | `shop-dev` Synced and Healthy at `ea54a10`; seed (PostSync) completes |
| 10:51 | `make smoke` passes |

Two gaps showed up on the way, both operator-side, neither in the shop's code:

- **The cluster lacked a new Secret key.** The storefront now reads `MERCHANT_CREDENTIALS`, but the
  `shop-secrets` Secret in the cluster did not have it: every `make secrets` during development ran
  while the cluster API was unreachable, and `cluster-secrets.sh` then skips the cluster by design.
  The new storefront pod sat in `CreateContainerConfigError`. The rolling update kept the previous
  storefront pod running, but that image predates tenancy, so with the new router and APIs in place
  shop pages would have failed for about ten minutes; this was not measured. `make secrets` applied the key and the pod started. Lesson: a release that adds a Secret key needs `make secrets` against the cluster before
  Argo CD syncs it.
- **The cluster API answered `EOF` from the laptop** (for `kubectl` and for the ingress on `:8080`)
  while k3s itself reported ready inside its container. The k3d load balancer container had been up
  30 hours and k3s had restarted underneath it under the build and test load of the day.
  `docker restart k3d-shop-serverlb` restored both paths.

## Smoke

`make smoke` (default `SHOP_DOMAIN=shop.localhost:8080`) passed in about 7 s:

```
smoke: OK - both shops serve their own catalogs at shop.localhost:8080 and a Checkout at http://harbor.shop.localhost:8080 was Confirmed
```

It checks Harbor Goods' and Meadow Supply's home pages, that neither shows the other's seeded
products, that `nowhere.shop.localhost` gets the router's 404, and one Checkout at Harbor Goods
through to Confirmed.

## Data and monitoring after the rollout

- The cluster's single-shop data was backfilled by the migration: all 209 Orders (the oldest from
  2026-10-10 08:41 UTC) and the 12 original products belong to Harbor Goods; Meadow Supply has its 5
  seeded products. All 8 tenant-owned tables have row-level security enabled.
- Prometheus scrapes all five units in `shop-dev` (`up` = 1 for catalog-cart-api, order-service,
  router, storefront, worker); the router is scraped on its private ops port. Its request counter
  shows the smoke traffic: 6 × 200, 2 × 303, 1 × 404. No alert was firing.

## Memory

Measured at 10:52 UTC, a few minutes after the sync.

| | Phase 0 (2026-10-10) | Phase 1 (2026-10-11) |
|---|---|---|
| k3d node container | 4,130 MiB | 3,342 MiB |
| Colima VM used / available | 4,052 / 5,869 MiB | 3,983 / 5,938 MiB |
| `shop-dev` namespace (working sets) | 216 MiB | 234 MiB |
| Argo CD | 435 MiB | 399 MiB |
| Monitoring | 882 MiB | 1,039 MiB |

Per-pod working sets in `shop-dev`: storefront 60 MiB, worker 39 MiB, PostgreSQL 36 MiB, router
33 MiB, order-service 30 MiB, catalog-cart-api 28 MiB, Redis 8 MiB. Elsewhere: Prometheus 549 MiB
(up from 375 MiB as a day of samples accumulated under 1-day retention), Grafana 403 MiB, Argo CD
application controller 275 MiB.

Conclusion: the router and tenancy cost about 18 MiB in the shop namespace, and about 5.9 GB of the
Colima VM is still available. The node container is smaller than in Phase 0 only because k3s
restarted earlier the same day; the comparison that matters is the namespace and the VM headroom.
Phase 3 (three cells) remains comfortably within budget at roughly 230 MiB per cell.

Commands: `docker stats --no-stream k3d-shop-server-0`, `kubectl top pods -A`,
`colima ssh -- free -m`; data checks with `psql` in `postgres-0`; Prometheus through
`kubectl port-forward svc/monitoring-kube-prometheus-prometheus`.
