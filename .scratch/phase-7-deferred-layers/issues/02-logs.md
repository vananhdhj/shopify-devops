# 02: Logs from every pod in Loki, through Alloy

**What to build:** Grafana Alloy (a DaemonSet) collecting every pod's JSON log lines into Loki (single-binary, filesystem, 24 h), with a Grafana datasource, labels bounded to namespace, cell, and app (decision 1).

**Blocked by:** none

**Status:** ready-for-agent

- [ ] Alloy and Loki in `deploy/monitoring` (pinned charts or manifests), each with memory limits within decision 1's budget; Loki on a PVC, 24 h retention
- [ ] Stream labels `namespace`, `cell`, `app` only; `tenant_id`, `requestId`, `traceId` stay in the line (LogQL `| json`)
- [ ] Grafana: the Loki datasource; the tenant dashboard gains the shop's recent error lines
- [ ] Nothing new is logged: Order tokens, Merchant credentials, and payloads stay out (the existing log tests hold)
- [ ] Cluster: a shop's lines found across cells and units, including a pod deleted since; the VM's memory before and after
