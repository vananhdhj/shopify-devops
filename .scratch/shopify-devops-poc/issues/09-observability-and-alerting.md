# 09: Observability and alerting — see health, get notified

**What to build:** The operator opens Grafana and sees request rate, errors, and latency per service, and the Pending-order and queue lifecycle; when something breaks, an alert reaches a private Discord channel and an in-cluster catcher, and later resolves. kube-prometheus-stack is deployed by Argo CD and trimmed to fit memory; dashboards and alert rules live in Git.

**Blocked by:** 04, 08

**Status:** ready-for-agent

- [ ] kube-prometheus-stack is deployed by Argo CD with 1-day retention and small resource requests; Grafana is reachable only by port-forward
- [ ] Prometheus scrapes all four units; metrics use route templates and bounded labels, never Order IDs
- [ ] Dashboards stored in Git show request rate, errors, and latency per service, Order confirmations and rejections by reason, queue depth, oldest Pending order age, and pod resources
- [ ] Alert rules in Git: server-error ratio above 5% over two minutes with a minimum request volume; oldest Pending order above 60 seconds
- [ ] Alertmanager routes alerts to the Discord webhook from the secrets file and to an in-cluster alert catcher
- [ ] Stopping the worker in the cluster fires the oldest-Pending alert at both receivers, and restarting it resolves the alert
- [ ] `make smoke` additionally places a Checkout and waits for a terminal Order

## Comments

- Carried from ticket 01 review: storefront logs become structured JSON (service, environment, severity, request ID), and the storefront forwards `x-request-id` to the APIs so one request can be followed across services.
