# 07: Fleet, cell, tenant, and control-plane dashboards; the plus tenants' SLO alert

**What to build:** Four Grafana dashboards in Git, and a multi-window burn-rate alert on Checkout availability for plus tenants.

**Blocked by:** 06

**Status:** in review

- [ ] Dashboards: `fleet`, `cell` (replaces `shop-overview`), `tenant`, `control-plane`
- [ ] `tenant_info` from the control plane (ticket 06; plays the planned `tenant_plan`); recording rules and the burn-rate alert (14.4× 1 h/5 m page, 6× 6 h/30 m ticket) for plus tenants
- [ ] Cluster: every dashboard shows real traffic (screenshots in the evidence)

## Comments

Implementation notes (2026-10-13):
- The dashboards move from `deploy/base` (a copy per cell, all with one uid, so they overwrote each other in Grafana) to the monitoring stack's config, one ConfigMap for the fleet: `deploy/monitoring/config/dashboards/{fleet,cell,tenant,control-plane}.json`.
  - **Fleet**: shops per cell, the synthetic Checkout's p95 and failures in a row by cell, requests, 5xx share, quota refusals, and oldest Pending by cell; the waves (soaking, halted, gate checks failing).
  - **Cell**: Phase 0's shop overview, chosen by `cell` instead of namespace. Its pod CPU and memory panels keep the namespace, which has no cell label in cAdvisor's series, through a hidden variable read from the cell's own targets. The edge panel reads `router_requests_total{cell}` instead of Traefik's per-service counter.
  - **Tenant**: a shop picked by handle, through `* on (tenant_id) group_left (tenant) max by (tenant_id, tenant) (tenant_info{tenant="$tenant"})`. Panels: requests by status class, rate-quota refusals, edge latency, Checkout latency and outcomes, Orders settled, oldest Pending, plan and cell.
  - **Control plane**: lifecycle completions, retries, signup-to-active p95, shops by plan, and the promoter's tick duration and outcomes.
- `deploy/monitoring/config/slo-rules.yaml`:
  - recording rules for each tenant's Checkout error ratio over 5 m, 30 m, 1 h, and 6 h, where a bad Checkout is `error` or `unavailable` (refusals, `busy` included, are answers);
  - `PlusTenantCheckoutBudgetBurnFast` (14.4× over 1 h and 5 m, `for: 2m`, page) and `PlusTenantCheckoutBudgetBurnSlow` (6× over 6 h and 30 m, `for: 15m`, ticket), for a 99% objective over 30 days, joined to `max by (tenant_id, tenant) (tenant_info{plan="plus", internal="false"})`.
  - The `max by` keeps the join one-to-one while two control-plane pods export `tenant_info` during a rollout.
- CI (manifests job) extracts the rule groups and runs `promtool check rules` and `promtool test rules`, with the Prometheus image the cluster runs. `tests/prometheus/slo-test.yaml` covers:
  - a plus and a starter shop each failing a third of their Checkouts, plus a plus shop that never fails, with `tenant_info` duplicated by two control-plane pods;
  - the 1 h ratio is 1/3;
  - at 70 minutes exactly one alert, for the failing plus shop, with its handle and summary;
  - at 1 minute, still inside `for`, none.
  The first test draft expected no page at 3 minutes; promtool showed that the 1 h rate over 3 minutes of data already burns, so the case became 1 minute.
- The README's known limits drop "no tenant dimension"; it names the dashboards and notes that per-shop limits live in each process's memory.

Verified locally: promtool check (6 rules) and test pass; the monitoring config renders one dashboards ConfigMap and the rule. The dashboards render on the cluster after #54's labels and this PR are live.
