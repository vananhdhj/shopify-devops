# 02: Logs from every pod in Loki, through Alloy

**What to build:** Grafana Alloy (a DaemonSet) collecting every pod's JSON log lines into Loki (single-binary, filesystem, 24 h), with a Grafana datasource, labels bounded to namespace, cell, and app (decision 1).

**Blocked by:** none

**Status:** resolved (amended 2026-10-15: logs read from the node's files)

- [x] Alloy and Loki in `deploy/monitoring` (pinned charts or manifests), each with memory limits within decision 1's budget; Loki on a PVC, 24 h retention
- [x] Stream labels `namespace`, `cell`, `app` only; `tenant_id`, `requestId`, `traceId` stay in the line (LogQL `| json`)
- [x] Grafana: the Loki datasource; the tenant dashboard gains the shop's recent error lines
- [x] Nothing new is logged: Order tokens, Merchant credentials, and payloads stay out (the existing log tests hold)
- [x] Cluster: a shop's lines found across cells and units, including a pod deleted since; the VM's memory before and after

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

Resolved 2026-10-14 with PR #67 (`548ddb7`) and its fix PR. On the lab cluster:
- **A first gap.** After the merge, `monitoring` stayed Synced and Healthy with no Loki or Alloy. The Application itself is not managed by Argo CD: `make bootstrap-gitops` applied it once, so its new chart sources never reached the cluster. Re-applied from main (14:43). The fix PR adds `make argocd-apps`, to re-run after changing an Application's definition; ticket 03's Tempo source needs it too.
- Loki and Alloy were ready at 14:45:44. Loki held 60 streams: 8 namespaces, 3 cells, 27 app values.
- **A second gap.** Pods with both an `app` and an `app.kubernetes.io/name` label got the two run together (`kube-prometheus-stack-prometheus-operatorkube-prometheus-stack-operator`). Fixed in the fix PR: the second replaces the first.
- One request through the ingress (`x-request-id: loki-check-0faa63dc`, to `nn-quiet-1-86d161`) was found in Loki within seconds: 2 lines from the edge, 1 from the storefront, 2 from the catalog API.
- **A pod deleted since.** The canary's only storefront pod (`storefront-6b698c96-g86nq`) was deleted at 14:47:26. Loki still held its 114 lines from the minutes before, the last 19 s before the kill; `kubectl logs` could no longer reach it.
- Grafana: the Loki datasource is there, and the tenant panel's query returned 20 lines for the canary's shop.
- Memory: Loki 95 MiB, Alloy 75 MiB. The VM's available memory went from 2,440 to 2,276 MiB.

Amended 2026-10-15 (fix PR "logs from the node's files"):
- **What happened.** An hour after ticket 03's rollout, the VM's load held near 38 with nothing deploying: k3s at 200% CPU, etcd failing readiness, metrics-server not ready (22 restarts), `crictl stats` timing out.
  - The API server served about 1.4 pod log CONNECTs and 1.7 pod GETs a second, and Alloy opened 432 log streams in 10 minutes. Its API tailers kept dropping and reopening, and each reopen loaded the API server further. The same reconnects lost lines in ticket 03's first run.
  - The pods themselves used under 1.5 cores in all (cadvisor, through Prometheus).
- **The change** (approved by the author):
  - Alloy reads `/var/log/pods` on the node (`loki.source.file`, the CRI format parsed, the `filename` label dropped), mounted read-only. One API watch remains, for the pods' labels.
  - The files are root-owned 0640, so the agent runs as root with every capability dropped and a read-only root filesystem.
  - The manifest policies list it as their one exception, with an owner, a reason, and an expiry (2027-01-15); an expired exception is a denial of its own.
  - Fixtures: the excepted agent passes, and the same root container under another name is denied.
- Stream labels stay namespace, cell, app, and `instance` (pod and container).
- Positions live in an emptyDir, so a replaced Alloy pod reads the node's current files again; Loki drops the exact duplicates it still holds.

Measured after the fix PR (#72) deployed (2026-10-14, 20:07 UTC):
- Alloy opened no log streams any more, one file tail per container instead. The API server's top requests no longer include pod log CONNECTs or GETs; k3s used 0.37 cores; the VM's 1-minute load fell from about 38 to 2.7; metrics-server was ready again.
- A tagged request's lines from the edge, the storefront, and the catalog API all arrived from the node's files. Two labels came with them: `stream` (stdout or stderr, from the CRI format) and Loki's `detected_level`, both bounded.
- Tempo, at 512 MiB, had not restarted (310 MiB, then 108 MiB). Alloy used 162–176 MiB of its 192 MiB.

