# 06: The tenant dimension, the cell label, continuous synthetic Checkouts

**What to build:** Five metrics gain a `tenant` label, every cell unit's metrics a `cell` label, and the promoter buys from every cell's synthetic shop every 30 s with its own metrics and an alert.

**Blocked by:** 01

**Status:** in review

- [ ] `router_requests_total{cell,tenant,code_class}`, `router_request_duration_seconds{cell,tenant}`, `checkout_duration_seconds{tenant,outcome}`, `orders_settled_total{tenant,outcome}`, `orders_oldest_pending_age_seconds{tenant}`
- [ ] PodMonitors add `cell` from a pod label set by each cell's kustomization
- [ ] Continuous synthetic Checkouts: `synthetic_checkout_total{cell,outcome}`, `synthetic_checkout_seconds{cell}`; alert `SyntheticCheckoutFailing`
- [ ] Seam-1 test: the labels appear; cluster: every cell's synthetic series has samples

## Comments

Implementation notes (2026-10-13):
- **The label is `tenant_id`, not the handle.** The worker and the order service's gauge know only ids, so every tenant-labelled series carries `tenant_id`.
  - The control plane exports `tenant_info{tenant_id, tenant, plan, cell, internal}` (1 per shop not deleted, read at scrape). Dashboards and plan-scoped alerts join on it: `* on (tenant_id) group_left (tenant, plan) tenant_info`.
  - `router_rate_limited_total` and `checkouts_busy_total` from tickets 02 and 03 move to `tenant_id` too.
- **The five metrics:**
  - `router_requests_total{cell,tenant_id,code_class}` and `router_request_duration_seconds{cell,tenant_id}` in the edge, empty labels for the platform's address and unknown hosts;
  - `checkout_duration_seconds{tenant_id,outcome}` (accepted, refused, busy, unavailable, error);
  - `orders_settled_total{tenant_id,outcome}`;
  - `orders_oldest_pending_age_seconds{tenant_id}`, from a new narrow function `orders.oldest_pending_by_tenant()`. The migration is expand-only; the cell-wide function stays for the previous release.
  A shop with no Pending Order has no series. The stale-Pending alert and the gate read `max` over the cell, unchanged.
- **The `cell` label.** Each cell's kustomization labels its pods `shop.example/cell` (pod templates only; selectors untouched), and both PodMonitors copy it into `cell`. The pod template changes, so every cell's pods roll once at the merge.
- **Continuous synthetic Checkouts.** `SyntheticProber` in the promoter buys from every cell's synthetic shop every 30 s (2 s in Compose), with `synthetic_checkout_total{cell,outcome}`, `synthetic_checkout_seconds{cell}`, and `synthetic_checkout_consecutive_failures{cell}`. `SyntheticCheckoutFailing` pages at two failures in a row. The soak gate keeps its own Checkouts.
- **Promoter fixes:**
  - `promoter_tick_seconds`, a histogram of tick durations: the slow ticks of tickets 01 and 04 become visible;
  - a soak starts only when a wave has shown the same candidate release on two ticks in a row, which ends the 15 s superseded soaks seen since Phase 4.

Tests:
- `tenant-metrics.test.ts`: the edge's request counter and histogram for Harbor in pool-1; a Checkout's histogram for Harbor, accepted; `tenant_info` for Harbor and for `synthetic-pool-1`.
- `promoter.test.ts`: the prober's passed Checkouts in pool-1, consecutive failures 0, and tick timing.
- Updated for the label: `metrics.test.ts` (a slow Order's tenant series), `worker-ops.test.ts`, `rate-limit.test.ts`.

`make test` with the cluster stopped: 41 files, 216 tests passed (320 s).
