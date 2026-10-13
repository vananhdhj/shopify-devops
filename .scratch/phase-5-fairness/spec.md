# Spec: Phase 5: fair sharing and observability

**Status:** resolved (2026-10-14: tickets 01–08 resolved; PRs #48–#56 and the ticket 08 PR merged and deployed to the lab cluster; the noisy-neighbour experiment met its bound)

Background: the blueprint (`~/workspace/Research/narrow/Shopify DevOps Portfolio Blueprint.md`) puts Phase 5 after wave delivery: "Fair sharing and observability: router rate limits, checkout and queue fairness, tenant dimension, synthetic tenants, dashboards and alerts". Its exit gate: "Noisy-neighbour experiment meets its bound; tenant and fleet dashboards show real traffic." The bound, from its experiments table: one tenant at 10× its rate quota receives `429`s, not `5xx`; the other tenants in its cell stay within 20% of their baseline checkout p95. Phases 1–4 are resolved, and ADRs 0001–0024 are binding.

Lessons that shape this phase:
- Every release now reaches the canary first and the other cells only through the gate (ADR-0022).
- Manifests reach every wave at the merge and must work with the previous images (ADR-0021).
- Migrations only expand.
- The host is the lab's limit: a load test must stay within what the 16 GB laptop can drive without starving the node it measures.

## Problem Statement

Inside a pooled cell nothing separates one shop from another except their data:
- a shop's flash sale, a scraper, or a bug sending requests in a loop takes the edge, the storefront, the APIs, and the database connections from every other shop in the cell;
- a burst of Orders fills the cell's one first-in-first-out settlement queue, so other shops' Orders wait behind it;
- no metric says which shop is suffering or causing it, and the dashboards show one shop's view from Phase 0;
- a plan buys a kind of cell but no amount of anything: a starter shop may add a million products.

## Solution

Limits per tenant, sized by plan, at each shared resource; and a tenant dimension in what the platform measures:
- **Request rate**: a token bucket per tenant in the edge. Over the limit, a request gets `429` with `Retry-After`, never a `5xx`, and never reaches the cell.
- **Checkout concurrency**: a cap on each tenant's in-flight Checkouts in the order service. Over the cap, the buyer gets a `429` page asking to retry, and the cell's database connections stay available to other shops.
- **Queue fairness**: the outbox dispatcher admits a bounded number of each tenant's Orders into the settlement queue, round-robin across tenants. A burst waits in its own tenant's outbox, behind nobody else.
- **Quotas**: per-plan limits on products, enforced in the catalog API and shown to the Merchant beside their usage and their request quota.
- **Tenant dimension**: the edge's request outcomes and latency, Checkout latency, Order outcomes, and the oldest Pending Order carry a `tenant` label (the handle). Everything carries the cell. The lab's pooled cap keeps the series bounded.
- **Synthetic tenants, continuously**: every cell's synthetic shop is bought from every 30 s, soak or not. Every cell is then measured even when its real shops are quiet, which also ends Phase 0's limitation that a traffic lull ends the error-ratio alert.
- **Dashboards and alerts**:
  - dashboards: fleet (cells, waves, releases, promotions), cell (rate, errors, duration, queue), tenant (requests, limits hit, Checkout latency, quota usage), control plane (lifecycle, promotions);
  - alerts: per-tenant error budget burn for plus tenants, and a cell's synthetic Checkout failing.

## Decisions (approved 2026-10-13)

1. **Queue fairness by fair dispatch**: the outbox dispatcher admits at most K of a tenant's Orders into the cell's one BullMQ queue at a time, taking tenants round-robin; the rest wait in the outbox, which is already durable. Alternatives:
   - a per-tenant token bucket in the worker: rejected, since a burst still sits at the head of the shared queue and every tenant waits behind its delays;
   - one queue per tenant: rejected, since queues would come and go with signups and need a worker that rotates across them;
   - BullMQ Pro groups: rejected as a paid license.
2. **Pooled cells take at most 20 shops in the lab** (the blueprint's proposed cap), so the tenant label stays bounded: about 20 tenants × a handful of series per cell. pool-1's capacity drops from 100 to 20; it holds 4 real shops.
3. **The rate limit's state lives in the edge's memory**: no extra hop or dependency on the request path. It is exact with today's single edge replica. With N replicas each would allow the full rate; that is documented, and revisited when the edge scales (a Phase 4 follow-up proposes a second replica). Alternative: a platform-level Redis, rejected for now as a new dependency on every request.

## User Stories

1. As a Merchant, another shop's traffic spike does not make my shop slow or unavailable.
2. As a Merchant whose shop exceeds its plan's request rate, my buyers see "slow down, try again in N seconds" (429), not an error page, and my shop recovers by itself.
3. As a Merchant, during my own flash sale my buyers queue for Checkout (a 429 page asking to retry) rather than the shop failing, and my Orders settle in turn without delaying other shops'.
4. As a Merchant, my admin shows my products against my plan's limit, and my plan's request rate, and refuses a product over the limit with a clear message.
5. As the platform operator, a tenant dashboard shows one shop's requests, limits hit, Checkout latency, Order outcomes, and quota use; a fleet dashboard shows every cell's wave, release, and health.
6. As the platform operator, I am paged when a plus shop burns its error budget, and when a cell's synthetic Checkout fails, even with no real traffic.
7. As a reviewer, I can run the noisy-neighbour experiment and read its result against the bound.

## Implementation Decisions

- **The plan in the tenant context**: the routing table carries each shop's plan, and the edge signs it into the tenant context, so the order service and the catalog API apply per-plan limits without asking the control plane. The context gains an optional field: units on the previous release ignore it, and a context without it means `starter`.
- **Plan limits** (proposed; in one module the edge and the services share):

  | | starter | plus | internal (synthetic) |
  |---|---|---|---|
  | Requests through the edge | 10/s sustained, burst 30 | 50/s, burst 150 | unlimited |
  | Checkouts in flight | 3 | 10 | 3 |
  | Products | 100 | 5,000 | 10 |
  | Orders admitted into the queue at a time (K) | 10 | 50 | 10 |

- **Edge rate limit**: a token bucket per tenant, refilled continuously. Over the limit: `429`, `Retry-After` in whole seconds, a short text body, and `router_rate_limited_total{cell,tenant}`. The bare platform domain (signup pages) is limited per client address, not per tenant.
- **Checkout concurrency**: an in-process semaphore per tenant in the order service. Over the cap the API answers `429 {"error":"checkout_busy"}`. The storefront renders a "Checkout is busy, try again in a moment" page with `429` and `Retry-After`, never a 500.
- **Fair dispatch**: `orders.claim_undispatched_events` gains a per-tenant bound. It claims at most K events of a tenant whose Orders are dispatched and still Pending, oldest first within a tenant, and interleaves tenants. This is a new migration (expand-only: a new function version beside the old, which stays for the previous worker until the contract release).
- **Product quota**: the catalog API refuses a product over the plan's limit with `409 {"error":"product_quota"}`. The Merchant admin shows "N of M products" and the request quota, and the add form explains a refusal.
- **Metrics with `tenant`**:
  - `router_requests_total{cell,tenant,code_class}` and `router_request_duration_seconds{cell,tenant}`;
  - `checkout_duration_seconds{tenant,outcome}` in the order service;
  - `orders_settled_total{tenant,outcome}` in the worker;
  - `orders_oldest_pending_age_seconds{tenant}`.
  Every other metric keeps no tenant. Each cell's units get a `cell` label through their PodMonitor (from a pod label), so dashboards group by cell, not namespace.
- **Continuous synthetic Checkouts**: the promoter runs a synthetic Checkout in every cell every 30 s, not only in a soaking wave, and exports `synthetic_checkout_total{cell,outcome}` and `synthetic_checkout_seconds{cell}`.
  - Alert `SyntheticCheckoutFailing`: two failures in a row in a cell.
  - The error-ratio alert's minimum request rate is then always met.
- **Dashboards** in Git as JSON (Grafana sidecar ConfigMaps): `fleet`, `cell` (variable: cell), `tenant` (variables: cell, tenant), `control-plane`. Phase 0's `shop-overview` is retired into `cell`.
- **SLO alert for plus tenants**: Checkout availability 99% over 30 days. Multi-window burn rate on the tenant's Checkout errors: 14.4× over 1 h and 5 m, severity page; 6× over 6 h and 30 m, ticket. Only for tenants whose plan is `plus`, via a recording rule that joins on a `tenant_plan` info metric from the control plane.
- **Noisy-neighbour experiment** (`make experiment-noisy-neighbour`): k6 in a container on the laptop, through the ingress.
  - **Baseline**: 5 minutes of steady browse and Checkout for three starter shops in pool-1.
  - **Noise**: then the same, plus one starter shop driven at 10× its rate quota (100 req/s, including Checkouts) for 5 minutes.
  - **Measured**: the noisy shop's 429 versus 5xx counts, and the others' Checkout p95 against their baseline; the bound is within 20%.
  - The rates are chosen so k6 and the cluster together stay inside the host's budget. The run records VM load, and is discarded if the host stalls (Phase 3 and 4 evidence).

## Testing Decisions

- Unit level: the token bucket, the plan limits table, and the fair-claim ordering as pure functions.
- Seam 1 (Compose):
  - the edge answers 429 with `Retry-After` past a starter tenant's burst while another tenant keeps 200;
  - concurrent Checkouts past the cap get the storefront's 429 page, and the others complete;
  - a burst of 50 Orders from one tenant does not delay a single Order of another tenant past its normal settle time;
  - the product quota refuses product 101 for a starter shop and shows "100 of 100";
  - the tenant label appears on the five metrics.
- Seam 2 (lab cluster): dashboards render real traffic, and the noisy-neighbour experiment, with a release through the waves for each ticket as usual.

## Out of Scope

- Tenant moves between cells, and moving a shop that outgrows its plan (Phase 6).
- Billing, plan changes by the Merchant.
- Per-tenant database connection pools.
- Distributed rate limiting across edge replicas (decision 3).
- Logs and traces with the tenant (Phase 7: Loki, Tempo).
