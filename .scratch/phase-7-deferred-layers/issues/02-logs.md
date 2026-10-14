# 02: Logs from every pod in Loki, through Alloy

**What to build:** Grafana Alloy (a DaemonSet) collecting every pod's JSON log lines into Loki (single-binary, filesystem, 24 h), with a Grafana datasource, labels bounded to namespace, cell, and app (decision 1).

**Blocked by:** none

**Status:** in review

- [x] Alloy and Loki in `deploy/monitoring` (pinned charts or manifests), each with memory limits within decision 1's budget; Loki on a PVC, 24 h retention
- [x] Stream labels `namespace`, `cell`, `app` only; `tenant_id`, `requestId`, `traceId` stay in the line (LogQL `| json`)
- [x] Grafana: the Loki datasource; the tenant dashboard gains the shop's recent error lines
- [x] Nothing new is logged: Order tokens, Merchant credentials, and payloads stay out (the existing log tests hold)
- [ ] Cluster: a shop's lines found across cells and units, including a pod deleted since; the VM's memory before and after

## Comments

Implementation notes (2026-10-14):
- Two more chart sources in the `monitoring` Application, so no Application needs bootstrapping:
  - `grafana/loki` 7.3.0 (Loki 3.6.11): single-binary, filesystem on a 2 Gi PVC, retention 24 h through the compactor, auth off, at most 8 labels a series. No caches, gateway, canary, rules sidecar, or scalable components. Requests 128 Mi, limit 256 Mi, `GOMEMLIMIT` 200 MiB.
  - `grafana/alloy` 1.13.1 (Alloy 1.20.1): a DaemonSet that discovers its node's pods (`NODE_NAME`) and reads their logs through the Kubernetes API (`loki.source.kubernetes`): no host paths and no root (user 473, read-only root filesystem, an emptyDir for its positions). Limit 192 Mi, `GOMEMLIMIT` 150 MiB; the config reloader 32 Mi.
  - Both images pinned by digest.
- Stream labels: `namespace`, `cell` (the pod label `shop.example/cell` of Phase 5), `app` (`app.kubernetes.io/name`, else `app`). Everything else stays in the JSON line.
- Grafana: a Loki datasource (`uid: loki`). The tenant dashboard gains a hidden `tenant_id` variable (from `tenant_info`) and a logs panel of the shop's warnings and errors from every unit: `| json | tenantId = "$tenant_id" or tenant = "$tenant" | severity =~ "warn|error"`. The APIs log the tenant id, the edge and the storefront the handle.
- Nothing new is logged; Alloy ships the lines the units already write, and the log tests of Phases 0–2 are unchanged.
- The manifest policies (ticket 01) now also check these two charts with the repository's values: `scripts/render-manifests.sh` renders them with `helm template`, at the versions the Application pins. That found their tag-only images, now pinned by digest. Approved repositories are now matched with their `:` or `@`, so `postgres-mirror.example.com/postgres` is refused (a new fixture). kube-prometheus-stack is still not rendered (upstream defaults; decision 4).
- Checked before merge: Alloy's config with `alloy fmt`, Loki's with `-verify-config`, and both charts with a server-side dry-run against the lab cluster.

`make policy`: 1,892 checks passed; 13 failing fixtures each denied by their rule.
