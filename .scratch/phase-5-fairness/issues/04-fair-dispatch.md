# 04: Fair dispatch into the settlement queue

**What to build:** The outbox dispatcher admits at most K of a tenant's Orders into the cell's queue at a time, round-robin across tenants, so a burst waits in its own tenant's outbox.

**Blocked by:** 01 (for K by plan)

**Status:** resolved

- [ ] Migration (expand-only): a new claim function bounding each tenant's dispatched-and-Pending Orders to K and interleaving tenants; the old function stays for the previous worker
- [ ] The worker uses the new function (the held-back count moves to ticket 06, where metrics carry the shop's handle; the worker knows only tenant ids)
- [ ] Seam-1 test: 50 Orders from one tenant, then one from another: the other's settles within its normal time

## Comments

Implementation notes (2026-10-13):
- `orders.claim_fair_events(batch, per_tenant)`, a new SECURITY DEFINER function. The Phase 1 `claim_undispatched_events` stays for the previous release's worker: expand-only, and the lint passes.
  - It counts each tenant's events dispatched whose Order is still Pending, ranks each tenant's waiting events oldest first, and admits only those that keep the tenant at or under `per_tenant`.
  - It orders by rank, then age: every tenant's oldest waiting event first, then every tenant's second, round-robin. The window function sits in a subquery, so the outer select can still lock `FOR UPDATE OF e SKIP LOCKED` for several worker replicas.
- The worker dispatches through it with `DISPATCH_PER_TENANT`, default `planLimits.starter.admittedOrders` (10), from `@shop/tenancy` (a new dependency of the worker; its Dockerfile already copied the package).
  - The worker has no tenant context, so one value applies to every shop. That is exact in practice: placement never mixes plans in a cell, since pooled cells hold starter shops and a dedicated cell holds one plus shop alone.
- Reconciliation still clears the dispatch mark of a Pending Order dispatched more than 30 s ago (5 s in Compose). Such an Order counts as waiting again and is admitted again under the same job id, which BullMQ ignores while the job exists.

Test (Compose, `fair-dispatch.test.ts`):
- A fresh shop places 50 Orders whose simulated payment takes 3 s each: about 30 s of work at 5 jobs at a time in a FIFO queue. Another fresh shop then places one Order.
- That Order is Confirmed in under 15 s while more than 20 of the burst are still Pending, and the burst never has more than 10 Orders dispatched and Pending. Then all 50 settle.

`make test` with the cluster stopped: 38 files passed (208 tests; the branch was cut before #51, whose tests run in CI after the rebase).

Resolved 2026-10-13 with PR #52 (`f31d8ca`). Its release waited out a Colima restart (the cluster was down from 07:30), then went through the waves: canary 13:53 to 14:04, pool-1 to 14:12, then dedicated-1. The new claim function is in every cell's schema. Fairness on the cluster is measured by the noisy-neighbour experiment (ticket 08).
