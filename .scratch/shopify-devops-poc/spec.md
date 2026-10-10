# Spec: Shopify DevOps lab — proof of concept

**Status:** ready-for-agent

Background: the full twelve-week blueprint lives outside this repo (`~/workspace/research/narrow/Shopify DevOps Portfolio Blueprint.md`); its "Proof-of-concept scope" section is the source of this spec. Domain vocabulary is defined in `CONTEXT.md`; ADRs 0001–0003 are binding.

## Problem Statement

The author wants a portfolio project that proves they can build, ship, observe, break, and recover a small commerce system, judged by recorded evidence rather than a list of installed tools. The full blueprint is a ten-to-twelve-week effort with about fourteen tools, too large to start blind. Before committing to it, the author needs to know two things: that the order logic can be made provably correct under retries, races, and crashes, and that a minimal real delivery loop (CI, GitOps, monitoring, rollback) actually fits and works on an Apple M2 laptop with 16 GB of RAM.

## Solution

Build a deliberately small single-merchant shop as four deployable units (storefront, catalog-cart API, order service, worker) over one PostgreSQL instance and one Redis queue. A Guest buyer browses products, fills a Cart, and performs a Checkout that returns a Pending order immediately; the worker then settles stock and a simulated Payment scenario asynchronously, producing a Confirmed or Rejected order without ever double-deducting stock. The Merchant signs in to add products and mark Confirmed orders as fulfilled.

Around that app, build one thin pass through every core DevOps layer: GitHub Actions tests and builds digest-identified images to GHCR and commits the new digest back to the repository; Argo CD deploys it to a local k3d cluster running on Colima; Prometheus, Grafana, and Alertmanager watch it and notify a private Discord channel; and a deliberately bad configuration release is detected by an alert and undone with `git revert`. Everything starts from documented `make` commands on a clean checkout.

## User Stories

### Guest buyer

1. As a Guest buyer, I want to see a list of products with names, prices, and availability, so that I can choose what to buy.
2. As a Guest buyer, I want to open a product's detail page and see the same price as on the listing, so that I can trust the price I'm shown.
3. As a Guest buyer, I want to add a product to my Cart without creating an account, so that I can shop with no sign-up friction.
4. As a Guest buyer, I want to change the quantity of a product in my Cart or remove it, so that my Cart reflects what I intend to buy.
5. As a Guest buyer, I want my Cart to survive a page reload and to be served by any storefront replica, so that I don't lose it when traffic is load-balanced.
6. As a Guest buyer, I want adding to my Cart never to hold stock, so that abandoned Carts don't block other buyers.
7. As a Guest buyer, I want to choose a Payment scenario (approve, decline, or slow) at Checkout, so that I can exercise every outcome of the simulated payment.
8. As a Guest buyer, I want Checkout to answer immediately with a Pending order and an Order token, so that I'm not left waiting on stock and payment processing.
9. As a Guest buyer, I want Checkout to charge server-owned prices, never prices sent from my browser, so that the shop's prices can't be tampered with.
10. As a Guest buyer, I want a retried Checkout (same Checkout key, same Cart, same Payment scenario) after a timeout to return my original Order, so that a network glitch never makes me buy twice.
11. As a Guest buyer, I want a reused Checkout key with a different Cart or Payment scenario to be refused with a conflict, so that a client bug can't silently create a different order under an old key.
12. As a Guest buyer, I want a second Checkout of a Cart that already became an Order to be refused, so that pressing Back and checking out again doesn't create a duplicate purchase.
13. As a Guest buyer, I want a fresh Cart after every Checkout, accepted or rejected, so that I can keep shopping without tripping the one-order-per-cart rule.
14. As a Guest buyer, I want to read my Order's status with my Order token, so that I can see whether it was confirmed or rejected.
15. As a Guest buyer, I want my Order page to show the exact items and prices captured at Checkout, so that later Cart edits or price changes don't alter what I bought.
16. As a Guest buyer, I want an Order whose stock ran out to be rejected without any partial stock deduction, so that a failed order holds nothing.
17. As a Guest buyer, I want an Order whose Payment scenario declined to be rejected with its stock released, so that declined orders don't consume inventory.
18. As a Guest buyer, I want my Order to stay Pending, not vanish or fail, while the shop's internals are down, so that an accepted Order is never lost.
19. As a Guest buyer, I want no one to read my Order without my Order token, so that my order status is private.

### Merchant

20. As the Merchant, I want to sign in with a password, so that only I can manage the shop.
21. As the Merchant, I want admin pages to redirect me to sign-in when I have no session, so that admin views are never shown to strangers.
22. As the Merchant, I want to add a product with a name, price, and starting stock, so that I can grow the catalog.
23. As the Merchant, I want to list all Orders with their status, so that I can see what needs fulfilling.
24. As the Merchant, I want to mark a Confirmed order as Fulfilled, so that I can record that I shipped it.
25. As the Merchant, I want marking any other kind of Order as Fulfilled to be refused, so that I can't ship a Pending or Rejected order by mistake.
26. As the Merchant, I want product writes and Order administration to be refused at the API without the admin service credential, so that bypassing the storefront doesn't bypass authentication.

### Operator

27. As the operator, I want killing the worker mid-Order to cause no double stock deduction and no lost Order, so that crashes are safe.
28. As the operator, I want twenty concurrent Checkouts for a product with one unit in stock to produce exactly one Confirmed order and never negative stock, so that overselling is impossible.
29. As the operator, I want two worker replicas processing the same queue to remain duplicate-safe, so that scaling the worker never breaks correctness.
30. As the operator, I want Orders accepted while Redis is down to be processed after it recovers, so that a queue outage loses nothing.
31. As the operator, I want a lost queue entry to be re-enqueued by reconciliation without generating new Inventory effects, so that recovery itself can't double-deduct.
32. As the operator, I want an alert when the oldest Pending order is older than 60 seconds, so that I learn about stuck processing without watching dashboards.
33. As the operator, I want an alert when the server-error ratio exceeds 5% over two minutes with minimum traffic, so that I learn about a bad release quickly.
34. As the operator, I want alerts delivered to a private Discord channel and to an in-cluster catcher, so that I get a real notification and automated tests can verify delivery offline.
35. As the operator, I want to see both the firing and the resolved notification of an alert, so that I know the alert path works end to end.
36. As the operator, I want dashboards for request rate, errors, and latency, and for the Pending-order and queue lifecycle, so that I can see the system's health at a glance.
37. As the operator, I want structured logs carrying service, request ID, and Order ID, and never Order tokens or credentials, so that I can investigate safely.
38. As the operator, I want to roll back a bad release by reverting a Git commit, so that every recovery action is recorded in history.
39. As the operator, I want a bad configuration release that breaks Checkout to be repeatable on demand, so that I can rehearse detection and rollback.
40. As the operator, I want Argo CD and Grafana reachable only through port-forwarding, so that admin tools are never exposed publicly.
41. As the operator, I want rotating a secret to be a single command followed by restarting the affected pods, so that rotation is routine and never touches Git.
42. As the operator, I want database migrations to run once, in a controlled job, before new application pods start, so that application and schema never race.
43. As the operator, I want pods to stop accepting traffic, drain in-flight requests, and let interrupted jobs retry on shutdown, so that deploys don't drop work.

### Developer (the author)

44. As the developer, I want one command to start the whole seeded app locally from a clean checkout, so that I can work without a cluster.
45. As the developer, I want one command to run the full test suite against real PostgreSQL and Redis, so that correctness is proven against real dependencies.
46. As the developer, I want a pull request to run lint, tests, secret scanning, and manifest validation without any deployment credentials, so that untrusted changes can't reach the cluster.
47. As the developer, I want only affected services tested and built, with shared-contract changes triggering every consumer, so that CI is fast but never skips a broken dependent.
48. As the developer, I want one always-running required check that fails on any failed or cancelled required job and accepts intentionally skipped ones, so that branch protection never hangs on skipped workflows.
49. As the developer, I want each image built once on main and identified by digest, so that what was tested is exactly what gets deployed.
50. As the developer, I want CI to commit the new image digest to the environment configuration, and that commit not to trigger another build, so that deployment is automatic without workflow loops.
51. As the developer, I want a committed secret to fail CI and be blocked by a pre-commit hook, so that the public repository never leaks credentials.
52. As the developer, I want the cluster and GitOps bootstrapped by documented commands, so that the lab is reproducible.
53. As the developer, I want the staging configuration rendered and validated in CI without running it, so that it stays correct within the laptop's memory budget.

### Reviewer

54. As a reviewer, I want to reproduce the lab from the README with no undocumented steps, so that I can verify the claims myself.
55. As a reviewer, I want each recorded experiment tied to a commit, image digest, and configuration revision, so that the evidence is traceable.
56. As a reviewer, I want ADRs explaining surprising decisions, so that I understand the trade-offs instead of second-guessing them.

## Implementation Decisions

### Deployment units and boundaries

- Four deployment units with only two business boundaries. **storefront** (Next.js App Router, plain CSS) owns no data and is the only unit exposed through ingress; it calls both APIs server-side, so the browser never reaches them and CORS is not needed. **catalog-cart API** (Fastify) owns products, Carts, authoritative prices, and Inventory effects. **order service** (Fastify) owns Checkout acceptance, Order status, and Order administration. **worker** belongs to the order boundary, sharing its code and database permissions; it dispatches the outbox, consumes the queue, requests Inventory effects, runs the Payment scenario, and records the final Order state.
- Shared code lives in workspace packages for API contracts, telemetry helpers, and the order domain. No shared ORM, no GraphQL.
- TypeScript on Node 24 LTS in every image; pnpm workspaces with Turborepo for builds and affected-package detection.

### API contracts

- Catalog-cart API: list products, get product, create Cart, get Cart, set a Cart item's quantity, admin create product, and the internal Inventory-effect endpoint. The internal endpoint accepts only the worker's internal service token and has bounded timeouts.
- Order service: Checkout, read Order by Order token, admin list Orders, admin set Order status (only Confirmed → Fulfilled).
- Checkout request carries Cart token, Checkout key, and Payment scenario. It reads Cart contents and current prices from the catalog server-side, then returns `202` with the Order ID and Order token. Conflicts return `409`: same Checkout key with a different request hash, or a Cart that already became an Order.
- Each API unit exposes liveness, readiness, and metrics endpoints outside the business routes; the worker has a private operational listener. Liveness tests the process only; readiness reflects whether the unit can serve, and a failing readiness check never acknowledges unfinished queue work.

### Data model

- One PostgreSQL instance, two schemas with separate owning identities, plus a migration identity. The catalog identity cannot read or write order tables; the order identity cannot write catalog tables. Both denials are tested.
- `catalog`: products (price in integer minor units, stock never negative), carts, cart items (quantity positive), inventory effects (unique per Order and action).
- `orders`: orders (unique Checkout key with stored request hash; unique source Cart ID per ADR-0001; status; Payment scenario; hashed Order token), order items (immutable item and price snapshot), outbox (stable event ID), order events (unique event ID, append-only status history).
- No cross-schema foreign keys; product IDs and Order IDs are plain references across the boundary.
- Plain SQL migrations run by dbmate: a one-shot service in Compose, an Argo CD PreSync job in the cluster. Migrations are backward-compatible so an image rollback never needs a schema rollback.

### Order processing

- The request hash covers Cart ID and Payment scenario only. The item snapshot taken at commit time is the record of what was bought (ADR-0001).
- Checkout writes the Pending order, its item snapshot, and one outbox event in a single transaction.
- The worker's dispatcher enqueues outbox events into BullMQ using the event ID as job ID. Queue delivery is at-least-once; correctness comes from idempotent effects, not exactly-once delivery.
- The consumer requests a deduction Inventory effect keyed by Order and action. The catalog locks product rows in a consistent order, checks every quantity, and writes stock changes plus the deduplication record in one transaction. Insufficient stock → Rejected order (out of stock) with no partial deduction.
- Payment scenario is stored on the Order, so retries reproduce the same outcome: `approve` → Confirmed; `decline` → release Inventory effect (separately idempotent), then Rejected order (payment); `slow` → waits a few seconds, then approves. If the release cannot be applied, the Order stays Pending and retries.
- Legal status transitions: Pending → Confirmed, Pending → Rejected (out of stock), Pending → Rejected (payment), Confirmed → Fulfilled. Each transition appends an order event atomically. A duplicate job for a terminal Order is a no-op.
- Outbox events are kept until the Order is terminal. Reconciliation periodically re-enqueues stale Pending orders and never creates Inventory effects with new keys.
- Pending orders never expire and cannot be cancelled (ADR-0002).
- Redis runs with persistence and a non-evicting memory policy and is used only as the queue.

### Merchant authentication and secrets

- The storefront verifies one admin password against a stored hash and issues a signed, httpOnly session cookie. It calls the APIs' admin endpoints with a separate admin service token. The human password never reaches the APIs.
- A `make secrets` command generates random values into a gitignored local secrets file and creates the Kubernetes Secrets: database credentials per identity, admin password hash, session signing key, admin service token, internal inventory token, Grafana admin password, and the Discord webhook URL. Compose reads the same file. Argo CD applications reference Secrets by name but never manage them. Rotation means rerunning the command and restarting the affected pods.
- Gitleaks runs in CI and as a pre-commit hook from the first commit.

### Local development

- Docker Compose runs the four units, PostgreSQL, Redis, and the migration and seed jobs on Colima (VM capped at 10 GB, `vz` type).
- Seed data: about 12 products, two of them with a stock of 1 for contention tests.
- Command interface: `make dev-up`, `make seed`, `make test`, `make dev-down`, `make secrets`, `make cluster-up`, `make bootstrap-gitops`, `make smoke`. A command reports success only after its health or correctness checks pass.
- Every image is multi-stage, runs as a non-root user, has minimal runtime dependencies, and takes configuration only from the environment.

### CI and delivery

- Pull requests: lint, tests through the service HTTP seam against real PostgreSQL and Redis, Gitleaks, and rendering plus validation of both overlays (dev and staging). No deployment credentials are available.
- Affected-service detection runs at job level. Changes to shared packages, lockfiles, or build infrastructure trigger every consumer. One always-running aggregate check is the single required status check.
- On main: build each affected image once, push to GHCR, and record the digest. Then commit the new digest into the dev environment overlay of this same repository, using a bot deploy key that is the only bypass on main's protection. The build workflow ignores commits that touch only deployment configuration (ADR-0003).
- Images are referenced by digest everywhere in deployment configuration, never by mutable tag.

### Cluster and GitOps

- k3d with one server on Colima, using the bundled Traefik with standard Ingress. The storefront is served at `http://shop.localhost:8080`.
- Argo CD with automated sync manages the application workloads and the platform components (kube-prometheus-stack) from Git via Kustomize overlays. Only the dev environment runs; staging is rendered and validated but never applied.
- Workloads declare resource requests and limits, startup, readiness, and liveness probes, and scoped service accounts. The worker runs one replica normally and two during the duplicate-safety and contention experiments.
- Rollback means reverting the environment's Git commit, never `kubectl rollout undo`.
- Argo CD, Grafana, PostgreSQL, and Redis are reachable only by port-forward.

### Observability

- Metrics: request rate, duration histogram, and server errors by route template; Order confirmations and rejections by reason; queue depth; oldest Pending order age; retries; worker throughput; dependency latency; pod resources. Order IDs never become metric labels.
- Logs: structured JSON with service, environment, severity, request ID, and Order or event ID, viewed through the container runtime. Never Order tokens, credentials, or request bodies.
- kube-prometheus-stack trimmed to fit memory: 1-day retention and small resource requests. Dashboards and alert rules are stored in Git.
- Alerts: server-error ratio above 5% over two minutes with a minimum request volume; oldest Pending order above 60 seconds. Alertmanager routes every alert to a private Discord channel webhook and to a small in-cluster alert catcher.
- A fault flag in the environment configuration makes Checkout return 500 for every request. A commit that enables it is the "bad configuration release" for the rollback demonstration.

## Testing Decisions

- **What makes a good test:** it exercises behavior only through a public seam (HTTP requests, process lifecycle, database end state) and survives a rewrite of internals such as the outbox, BullMQ wiring, or Inventory-effect storage. Tests assert business outcomes (Order status, stock quantity, number of Orders, notifications received), not internal calls.
- **Seam 1, service HTTP (main seam):** tests run against the Compose stack with real PostgreSQL and Redis, call the APIs over HTTP, control the worker as a container, and read the database to assert end state. Coverage:
  - product listing and detail price agreement
  - Cart persistence across replicas
  - Checkout → Confirmed, Rejected (out of stock), and Rejected (payment) for each Payment scenario
  - 100 retries of one Checkout key produce one Order
  - a Checkout key with a changed Cart or Payment scenario conflicts
  - a second Checkout of an ordered Cart conflicts
  - 20 concurrent Checkouts for one unit produce exactly one Confirmed order and never negative stock
  - killing the worker after the stock deduction does not deduct twice
  - two worker replicas stay duplicate-safe
  - a Redis outage followed by reconciliation loses no Order
  - an illegal status transition is refused
  - requests without admin session or service credential are rejected
  - the internal Inventory-effect endpoint rejects callers without the internal token
  - cross-schema database access is denied for each identity
- **Seam 2, deployed system:** `make smoke` runs from the laptop against `http://shop.localhost:8080` on the k3d deployment. It checks that the storefront serves products and that a Checkout reaches a terminal state. In drill mode it verifies that the bad configuration release triggers the server-error alert at the in-cluster catcher, that `git revert` restores Checkout, and that the alert resolves.
- No unit tests on internal functions unless a pure function is genuinely unreachable through seam 1; no browser-automation tests for the storefront UI.
- Seam 1 runs on every pull request in CI. Seam 2 runs locally, because GitHub-hosted runners cannot reach the laptop cluster.
- Prior art: none; the repository is greenfield. The blueprint's reliability-experiments table supplies the acceptance targets, and each recorded run notes hardware, replica counts, commit, and image digest.

## Out of Scope

- Everything the blueprint defers beyond the POC: Loki/Alloy, OpenTelemetry/Tempo, Conftest policy gates, Trivy image scanning, Sealed Secrets, network policies, HPA and Metrics Server experiments, k6 load runs, the data-recovery drill, progressive delivery, Terraform, AWS, ECR promotion.
- Running the staging environment (it is only rendered and validated).
- Order expiry and Merchant cancellation (ADR-0002).
- All commerce breadth listed as non-goals in the blueprint: tenants, themes, discounts, email, buyer accounts, returns, shipping, tax, real payments.
- Node-level high availability claims; the lab is a single-server cluster.

## Further Notes

- **Steps only the author can perform**, batched per milestone: install Colima, gh, k3d, and helm and start Colima; run `gh auth login`; create the public GitHub repository; add the bot deploy key and the branch-protection bypass; create the Discord webhook.
- **Verify during implementation, not from memory:**
  - that a deploy key can be the sole bypass on main's ruleset, and the exact trigger behavior of its pushes
  - whether GHCR packages pushed from this public repository are public by default or need a one-time visibility change
  - that the whole cluster stack fits in Colima's 10 GB; measure memory once the platform charts are up and record it
- The memory fit is the main feasibility risk. Bringing up the cluster and platform components early, before the full app is deployed, surfaces it soonest.
