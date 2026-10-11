# shopify-devops

A small multi-tenant commerce platform, used as a DevOps lab: many shops, each run by its own
merchant, on shared infrastructure. Build it, ship it, watch it, break it, and recover it, with
every claim backed by recorded evidence. The commerce features stay deliberately narrow; the depth
goes into what a platform for many businesses must get right: keeping every shop's data apart,
and delivering and recovering without one shop's trouble reaching the others.

The proof of concept (Phase 0) answered two questions: can the order logic be made provably
correct under retries, races, and crashes, and does a real delivery loop (CI, GitOps, monitoring,
rollback) fit and work on one Apple M2 laptop with 16 GB of RAM? Both answers are yes; the numbers
are under [Measured results](#measured-results). Phase 1 runs two shops in one **cell** (one
complete copy of the system), with the database itself keeping them apart.

## The shops

Two seeded shops, **Harbor Goods** and **Meadow Supply**, each at its own address
(`harbor.shop.localhost`, `meadow.shop.localhost`), with its own catalog, Carts, Orders, and
Merchant password. The static tenant table is [`deploy/base/tenants.json`](deploy/base/tenants.json).

- A **router**, the only unit on the ingress, maps the address to a **tenant** and attaches a signed
  **tenant context**; nothing downstream believes a shop named any other way
  ([ADR-0011](docs/adr/0011-tenant-identity-from-a-signed-router-context.md)). An address that
  names no shop gets one fixed 404.
- Every shop-owned row carries a `tenant_id`, and PostgreSQL row-level security limits each service
  to the tenant of its current transaction; a transaction with no tenant sees nothing
  ([ADR-0010](docs/adr/0010-pooled-tenancy-with-row-level-security.md)). The worker's
  cell-wide jobs reach other tenants only through four narrow database functions
  ([ADR-0012](docs/adr/0012-cross-tenant-work-through-narrow-functions.md)).
- An isolation suite proves on every pull request that no API path, token, password, session, or
  database session of one shop reaches another's data.

## What each shop does

- A **Guest buyer** browses about a dozen seeded products, fills a **Cart** (no account), and
  checks out with a simulated **Payment scenario**: `approve`, `decline`, or `slow`.
- **Checkout** answers at once with a **Pending** order and an **Order token** (the buyer's only
  key to read the Order). A worker then deducts **Stock** and runs the Payment scenario, ending in
  **Confirmed** or **Rejected** (out of stock, or payment declined, with the Stock released).
- The shop's **Merchant** signs in to add products and mark Confirmed orders as **Fulfilled**.

Correctness rules the tests prove: a retried Checkout (same Checkout key) returns the same Order;
a Cart becomes at most one Order ([ADR-0001](docs/adr/0001-one-cart-becomes-at-most-one-order.md));
Stock is never deducted twice or driven negative, under concurrent Checkouts, duplicate jobs,
two worker replicas, or a worker killed mid-Order; Orders accepted during a Redis outage are
settled after it; Pending orders never expire ([ADR-0002](docs/adr/0002-pending-orders-never-expire.md)).
The domain vocabulary is defined in [CONTEXT.md](CONTEXT.md).

```
browser ──> router ──> storefront (Next.js) ──┬──> catalog-cart API (Fastify) ──> PostgreSQL: catalog schema
 <shop>.shop.localhost  every shop, behind    └──> order service (Fastify) ─────> PostgreSQL: orders schema + outbox
 only unit on ingress   the router                                      (tenant_id + row-level security on every table)
 host → tenant, signs the tenant context                                                     │
                       worker ──< Redis (BullMQ queue) <── outbox dispatcher ────────────────┘
                         └── Inventory effects (deduct / release, once per tenant, Order, and action) ──> catalog-cart API
```

TypeScript on Node 24, pnpm workspaces with Turborepo; PostgreSQL 18, Redis 8.

## Prerequisites

Tested on macOS (Apple silicon). Install with Homebrew:

```sh
brew install colima docker docker-compose k3d kubectl helm gh gitleaks jq node@24 pnpm
colima start --cpu 6 --memory 10 --vm-type vz
```

Colima replaces Docker Desktop. The 10 GB VM is the lab's memory budget; everything below runs
inside it. Follow Homebrew's note for `docker-compose` to register it as the `docker compose` plugin.

**Author-only steps**, needed only to run the delivery loop from your own GitHub repository
(everything else works from a clone of this one):

1. Fork or create the repository, and replace `vananhdhj` with your account under `deploy/`
   (image names and the Argo CD `repoURL`).
2. `gh auth login`.
3. Add a write **deploy key** and store its private half as the Actions secret `DEPLOY_KEY`; keep
   exactly one write deploy key, because the bypass below covers all of them.
4. Add a ruleset on `main`: require a pull request and the `ci-ok` check, block force pushes and
   deletion, with the `DeployKey` actor as the only bypass ([ADR-0003](docs/adr/0003-ci-commits-image-digest-to-same-repo.md)).
5. Optional: create a Discord webhook for a private channel and add
   `DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...` as its own line in
   `.secrets/dev.env`, then rerun `make secrets`. Without it, alerts still reach the in-cluster
   alert catcher.

GHCR images inherit the repository's public visibility; no manual step was needed.

## Run it

### Locally with Docker Compose

```sh
make dev-up     # generates secrets, builds, starts, migrates, seeds; returns once healthy
open http://harbor.shop.localhost:8000 http://meadow.shop.localhost:8000
make test       # typecheck + the service-HTTP and isolation tests against real PostgreSQL and Redis (~4 min)
make dev-down
```

Each Merchant signs in at their shop's `/admin/login` with their own password from
`.secrets/dev.env` (`MERCHANT_PASSWORD_HARBOR`, `MERCHANT_PASSWORD_MEADOW`). Every `*.localhost`
name resolves to this machine, so no hosts-file entries are needed.

### On the lab cluster with GitOps

```sh
make secrets            # .secrets/dev.env (if not already there)
make bootstrap-gitops   # k3d cluster, Argo CD, cluster Secrets, the shop-dev and monitoring apps
kubectl --context k3d-shop -n argocd get applications   # wait for Synced / Healthy
make smoke              # both shops serve their own catalogs, an unknown shop gets 404, a Checkout is Confirmed
open http://harbor.shop.localhost:8080 http://meadow.shop.localhost:8080
```

Argo CD then deploys whatever `main` holds. Admin tools are reached only by port-forward:

```sh
kubectl --context k3d-shop -n argocd port-forward svc/argocd-server 8081:80
kubectl --context k3d-shop -n monitoring port-forward svc/monitoring-grafana 8082:80   # admin / GRAFANA_ADMIN_PASSWORD
```

### Drills

```sh
make drill-stale-pending    # stops the worker: ShopOldestPendingOrderStale fires, then resolves
make smoke MODE=fault       # after merging a commit that sets FAULT_CHECKOUT_ERRORS=true in deploy/overlays/dev
make smoke MODE=recover     # start before merging the `git revert`; ends when the alert has resolved
```

The bad-release drill is written up step by step in
[the drill evidence](docs/evidence/2026-10-10-bad-release-drill.md).

## Delivery path

1. **Pull request.** CI runs lint (Biome), typecheck and image builds for the affected services,
   the service-HTTP tests against a throwaway Compose stack on both amd64 and arm64 runners, Gitleaks, and rendering plus schema
   validation (kubeconform) of the dev and staging overlays, the monitoring config, and the Argo CD
   Applications, including a check that every image is pinned by digest. One aggregate check,
   `ci-ok`, is the only required check, so skipped jobs never leave the pull request waiting. Pull
   requests get no deployment credentials.
2. **Merge to `main`.** The release workflow builds each affected image once, natively on amd64
   and arm64 runners, pushes it to GHCR by digest, and merges a multi-arch index.
3. **Digest commit.** The `deploy-dev` job commits the new digests into `deploy/overlays/dev`
   with the deploy key, the one identity allowed to bypass the ruleset. Commits that touch only
   `deploy/` do not start another release.
4. **GitOps.** Argo CD polls `main`, syncs the dev overlay with automated prune and self-heal,
   runs the database migration as a PreSync job, rolls the Deployments, and reseeds the dev data
   as a PostSync job.
5. **Observe.** kube-prometheus-stack, itself deployed by Argo CD, scrapes the services and
   Traefik. Two alert rules live in Git (5xx ratio above 5% over two minutes with a minimum
   request rate; oldest Pending order older than 60 s) and Alertmanager sends each firing and
   resolved notification to Discord and to an in-cluster alert catcher.
6. **Roll back.** Revert the commit with `git revert` and merge it like any other change. Never
   `kubectl rollout undo`: the cluster always matches `main`.

## Security model

- **Secrets never enter Git.** `make secrets` generates random values into `.secrets/dev.env`
  (git-ignored, mode 600) and copies them into Kubernetes Secrets; Argo CD Applications only
  reference Secrets by name. Gitleaks runs as a pre-commit hook (`make hooks`) and in CI.
- **Tenants.** A request's shop comes only from the router's signed tenant context; the storefront
  and both APIs refuse requests without a valid one, and the database refuses any row outside the
  transaction's tenant. Keys and foreign keys are tenant-scoped, so even the table owner cannot
  put another shop's product in a Cart (tested).
- **Merchants.** Each shop has its own password; only scrypt hashes reach the storefront, which
  issues a signed, httpOnly session cookie valid at that shop only. The APIs' admin endpoints
  require a separate admin service token, which never names a shop; the human password never
  reaches them. Admin pages and form posts refuse visitors without a session and cross-site posts.
- **Orders.** The Order token is an HMAC of the tenant id and order id and is never stored
  ([ADR-0004](docs/adr/0004-order-token-is-an-hmac-of-the-order-id.md)). A wrong token, another
  shop's Order, and an unknown Order answer the same 404.
- **Least-privilege database.** A migration identity owns the schemas; each runtime identity has
  only the table privileges its service needs, and cross-schema access is denied (tested). Only
  the worker's internal token can change Stock.
- **Logs and metrics** use route templates, never raw URLs, query strings, Order tokens,
  credentials, or request bodies (tested for each service).
- **Exposure.** Only the router is on the ingress, bound to `127.0.0.1:8080`; its health and
  metrics are on a private port. Argo CD, Grafana, PostgreSQL, and Redis are reachable only by
  port-forward.
- **Supply chain.** Actions are pinned to commit SHAs, downloaded tools are checksum-verified,
  images run as non-root and are deployed by digest only.

## Known limits

- One single-node k3d cluster on a laptop: no high availability, and the "dev" environment is the
  only one running. The staging overlay is rendered and validated in CI but never applied.
- One cell. Shops are added by editing the static tenant table and the seed data; signup, a
  control plane, and more cells come in later phases of the blueprint.
- Metrics have no tenant dimension yet: dashboards and alerts are per cell, and the oldest-Pending
  gauge spans every shop. Per-shop rate limits and queue fairness are not in place either, so one
  busy shop can slow the others.
- `make smoke` and the drills run only from the laptop, because GitHub-hosted runners cannot reach
  the cluster.
- Argo CD polls Git (no webhook): about a minute passes between a merge and the start of its sync.
- A change to the shared `shop-env` ConfigMap restarts all four Deployments, not only the one that
  reads the changed key.
- The 5xx alert needs a minimum request rate, so a lull in traffic can end it while requests still
  fail. `keep_firing_for: 1m` holds it through lulls up to a minute, at the cost of resolving a
  minute later; a longer lull still ends it. It can also fire again just after a fix while old
  errors remain in its 2-minute window. The drill keeps traffic steady for both reasons.
- The dev seed job resets seed products' price and Stock on every sync.
- Logs are read through the container runtime; there is no log store or tracing. Discord delivery
  is checked by eye.
- Pending orders never expire and cannot be cancelled (ADR-0002); two simultaneous "add" clicks
  from one buyer can lose an increment.
- Out of scope so far: Loki, OpenTelemetry, policy gates, image scanning, Sealed Secrets,
  network policies, autoscaling, load tests, data-recovery drills, progressive delivery, cloud
  infrastructure, and commerce breadth such as accounts, shipping, tax, and real payments.

## Measured results

All on an Apple M2 with 16 GB RAM, Colima 6 CPUs / 10 GB, on 2026-10-10.

| What | Result |
|---|---|
| Service-HTTP test suite | 101 tests pass locally and in CI, including 100 concurrent retries → one Order, 20 concurrent Checkouts for the last unit → one Confirmed, a worker killed between deduction and confirmation → one deduction, two worker replicas, and a Redis outage with reconciliation |
| Memory, whole lab (k3s, shop, Argo CD, kube-prometheus-stack) | k3d node 4.0 GiB; 5.7 GB still available in the Colima VM. Grafana (415 MiB) and Prometheus (375 MiB) are the largest pods ([memory evidence](docs/evidence/2026-10-10-k3d-memory.md)) |
| GitOps loop | Merge → multi-arch build → digest commit by the deploy key (no release loop) → Argo CD sync in about 35 s; a worker scaled to 0 by hand was restored by self-heal within about 2 s |
| Stale-Pending alert drill | Worker stopped: alert firing about 70 s after the Order was placed, at both receivers; resolved about 30 s after the worker returned, and the Order was Confirmed |
| Bad-release drill | Fault live → FIRING notification in 1 min 34 s; FIRING → Checkout working again via `git revert` in 2 min 14 s; RESOLVED 2 min 12 s later; Checkout down 3 min 48 s in total ([drill evidence](docs/evidence/2026-10-10-bad-release-drill.md)) |

Failed experiments, kept on record:

- **False recovery signal (bad-release drill, run 1).** Light recovery traffic let the 5xx alert
  resolve 36 s *before* the revert reached the pods, and it fired again after recovery. The drill
  now keeps traffic steady and accepts only a resolution after Checkout has recovered.
- **amd64-only images** could not run on the arm64 laptop when pulled by digest; the release now
  builds natively for both architectures.
- **CI caught a race in two tests** that read an Order immediately after Checkout, before the
  worker settled it; the tests now accept either state.
- **A corrupted Discord webhook**: a hand-pasted secrets line without a trailing newline had the
  next generated key appended to it, and Discord answered 401. `make secrets` now ends the file
  with a newline first.
- **The ruleset bypass** for the deploy key could not be added by the automation (held by a
  safety check) and needed the repository owner, and two attempts in the GitHub UI did not save
  before it was applied through the API.

## Teardown

```sh
make dev-down       # Compose stack
make cluster-down   # deletes the k3d cluster, including Argo CD and monitoring
colima stop
```

Generated secrets stay in `.secrets/dev.env`; delete the folder to start from scratch.

## Repository map

- `apps/`: router, storefront, catalog-cart-api, order-service, worker, db-migrations
- `packages/`: shared API contracts, service plumbing, and tenancy (the signed tenant context)
- `tests/integration/`: the service-HTTP test suite
- `deploy/`: Kustomize base and overlays, Argo CD Applications, monitoring, k3d config
- `scripts/`: secrets, smoke and drills
- `docs/adr/`: decisions; `docs/evidence/`: measurements and drill records
- `.scratch/`: specs and tickets, one folder per phase
