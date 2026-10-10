# 09: Observability and alerting — see health, get notified

**What to build:** The operator opens Grafana and sees request rate, errors, and latency per service, and the Pending-order and queue lifecycle; when something breaks, an alert reaches a private Discord channel and an in-cluster catcher, and later resolves. kube-prometheus-stack is deployed by Argo CD and trimmed to fit memory; dashboards and alert rules live in Git.

**Blocked by:** 04, 08

**Status:** resolved

- [x] kube-prometheus-stack is deployed by Argo CD with 1-day retention and small resource requests; Grafana is reachable only by port-forward
- [x] Prometheus scrapes all four units; metrics use route templates and bounded labels, never Order IDs
- [x] Dashboards stored in Git show request rate, errors, and latency per service, Order confirmations and rejections by reason, queue depth, oldest Pending order age, and pod resources
- [x] Alert rules in Git: server-error ratio above 5% over two minutes with a minimum request volume; oldest Pending order above 60 seconds
- [x] Alertmanager routes alerts to the Discord webhook from the secrets file and to an in-cluster alert catcher
- [x] Stopping the worker in the cluster fires the oldest-Pending alert at both receivers, and restarting it resolves the alert
- [x] `make smoke` additionally places a Checkout and waits for a terminal Order

## Comments

- Carried from ticket 01 review: storefront logs become structured JSON (service, environment, severity, request ID), and the storefront forwards `x-request-id` to the APIs so one request can be followed across services.
- Carried from ticket 03 review: the buyer's Order link carries the Order token as `?token=` (ADR-0004), so storefront request logs must record paths without query strings; add a test like the order-service one asserting no Order token appears in storefront logs.


Resolved 2026-10-10.
- App changes (PR #7): storefront JSON request logs (service, environment, severity, request ID; paths without query strings) and `x-request-id` forwarding to the APIs; storefront metrics on :9464; the oldest-Pending gauge served by order-service. `make test` passes (99 tests), including a storefront log test asserting no Order token appears.
- Cluster: kube-prometheus-stack 92.3.0 deployed by the Argo CD `monitoring` Application (1-day retention, 1 GB cap, ClusterIP only). 18 scrape targets up, including the three APIs and worker, storefront, and Traefik; both alert rules loaded; the shop overview dashboard (16 panels) loaded from Git by the Grafana sidecar.
- Alert drill (`make drill-stale-pending`): worker stopped 10:38:19 UTC, Order Pending at 10:38:23; ShopOldestPendingOrderStale fired at 10:39:31 and reached the catcher at 10:39:42; worker restored, alert resolved at 10:40:01, catcher at 10:40:11; the Order then read Confirmed. Discord received the alert, and Alertmanager logged no notification failures.
- A first drill reached only the catcher: Discord answered 401 "Invalid Webhook Token" because the hand-pasted `DISCORD_WEBHOOK_URL` line had no trailing newline and `make secrets` appended the next key onto it. `scripts/secrets.sh` now ends the file with a newline before appending.
- Memory: 4.0 GiB for the k3d node with shop, Argo CD, and monitoring; 5.7 GB still available in Colima (docs/evidence/2026-10-10-k3d-memory.md).
- Carried items done: storefront structured logs and request-ID forwarding (from ticket 01); storefront logs paths without query strings, with a test (from ticket 03).
