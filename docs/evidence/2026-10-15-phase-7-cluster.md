# Phase 7 on the lab cluster: manifest policies, logs, traces, sealed secrets, a rotation, autoscaling (tickets 01–07)

Recorded 2026-10-14/15 (times UTC) on the author's workstation: Apple M2, 16 GB RAM; Colima VM with 6 CPUs and 8 GB; k3d 5.9.0 running one k3s v1.35.5 server; Argo CD v3.5.4. Cells: `canary` (wave 0), `pool-1` (wave 1), `dedicated-1` (wave 2).

## Exit gate

| The blueprint's gate | Result |
|---|---|
| Follow one tenant's Order across router, cell, and queue in traces | `make experiment-trace`: one trace of 22 spans from the edge, the storefront, the order service, the catalog API, and the worker, across the outbox and the queue |
| Bad manifest blocked | PR #83, a privileged container: CI's `manifests` job failed with `no-privileged` in all four cells it renders, `ci-ok` failed, GitHub reported it BLOCKED; closed unmerged |
| Secret rotation rehearsed | dedicated-1's tenant-context secret rotated in three steps through Git, no request refused; the sealing key's restore rehearsed too |

### One Order in one trace

`make experiment-trace`, 2026-10-14 17:54:37: a Checkout of Harbor Goods (pool-1) through the ingress, its trace found in Tempo by the Order id (TraceQL `{ span.order.id = "…" }`):

| From the edge's start | Took | Unit | Span |
|---|---|---|---|
| 0 ms | 43 ms | router | `POST /*` (Harbor, pool-1) |
| 4–9 ms | 35 ms | storefront | Next.js's spans, `fetch POST …/checkout` |
| 12 ms | 30 ms | order-service | `POST /checkout` (Harbor, the Order), its transactions |
| 17 ms | 13 ms | order-service → catalog-cart-api | `GET catalog /carts/:id` → `GET /carts/:id` |
| 56 ms | 0 ms | worker | `outbox dispatch` (producer) |
| 56 ms | 9 ms | worker | `settle order` (consumer) |
| 59 ms | 5 ms | worker → catalog-cart-api | inventory deduct → `POST /internal/inventory-effects` |

The trace context crossed the outbox in the row's `trace_context` column and the queue in the job's data. From the edge to the settlement's last transaction it took 66 ms.

On a calm cluster, every log line of a repeated trace was in Loki, matching the pods' own logs (edge 1, order service 2, catalog API 3, worker 1). Grafana links a span to its trace's log lines and a line's `traceId` to its trace.

### The rotation

`make rotate-tenant-context CELL=dedicated-1 STEP=…`. Each step was a pull request of re-sealed files only; a probe asked dedicated-1's shop (`mv-exp-5ee0b6`) for its home page through the ingress twice a second.

| Step | PR | What changed | Requests after the merge | Refused |
|---|---|---|---|---|
| expand | #77 | the cell accepts a next secret; its catalog API, order service, storefront restarted | about 300 (459 in the whole window) | 0 |
| switch | #80 | the edge signs with the next secret, read from its key file in place, no restart | 1,039 (3,544 in the window) | 0 |
| contract | #81 | the next secret the cell's only one; the units restarted | 206 (926 in the window) | 0 |

**No request was refused.** The probe's other misses were timeouts, no answer within 5 s, from the host:
- 130 during expand, while pool-1's first autoscalers had tripled it (below);
- 1 sixteen minutes before the switch's merge;
- 1 during contract's apply, with the VM's load near 13.

At the end, dedicated-1 holds one `TENANT_CONTEXT_SECRET`, equal to the edge's key for it (both hash to `c5834c676a21`), and no unit has a next secret.

### The sealing key's restore

The SealedSecrets of the three cells, the edge, the control plane, and monitoring (nine, all `Synced`):
1. The controller's key was deleted, and the controller restarted. It made a new key, and a resync answered `no key could decrypt secret`; the Secrets kept their values.
2. `make seal-key-restore` brought back the backup from `.secrets/`; the stray key was deleted.
3. All nine were `Synced` again within 6 s, and the committed `cert.pem` is still the active certificate.

## Autoscaling

`make experiment-autoscale`, 00:47: four starter shops in pool-1, 8 home pages a second each for 4 minutes (7,479 requests; 45 not 2xx, most likely timeouts; p95 3.6 s).
- pool-1's storefront went from 1 to 2 replicas 82 s into the load, and to 3 a minute later (one pod a minute). It was back at 1 five and a half minutes after the load.
- The catalog API stayed at 1, its CPU over its 80m target only briefly.
- The VM's load peaked at 11.2; available memory fell to 1,929 MiB.

## Releases

Every image release reached every wave with no human step: #69's traces, #75's two-key verification, and those of #66, #76, and #78. #79 then made a release rebuild only what images are built from: the merges of #79 and #82 ran the release workflow and built nothing.

## What broke, and what held

- **Application definitions are not synced.** After #67, `monitoring` stayed Synced and Healthy with no Loki: Argo CD syncs what an Application points at, not the Application. `make argocd-apps` (#68) re-applies them.
- **Alloy's API log streams overloaded k3s.** Read through the Kubernetes API, Alloy's log streams kept reopening (432 in 10 minutes): k3s at 200% CPU, etcd failing readiness, metrics-server down, and lost lines when tailers reconnected during a rollout. Since #72 Alloy reads the node's log files as root (read-only, every capability dropped), the manifest policies' one listed exception, with an owner and an expiry; the VM's load fell from about 38 to 2.7.
- **Tempo was OOM-killed at 256 MiB** (8 restarts, each replaying its WAL). It runs at 512 MiB since #72.
- **The first autoscalers scaled out with no load and could not scale in** (#76): 70% of a 50m request was an idle pod's cost. They took pool-1's storefront and catalog API to 3 each on startup bursts and kept them there, which, with full releases set off by script changes, held the VM at loads of 30–47. #78 targets an average CPU per pod (150m, 80m) and adds at most one pod a minute; #79 stops script and CI changes from rebuilding images.
- **Gitleaks flagged the sealed ciphertext** (46 findings). `.gitleaks.toml` allows only one key's kubeseal ciphertext on its own line in `deploy/**/sealed-*.yaml`; a planted live-looking key in a sealed file was still caught.
- **Restarting the cluster with the Compose stack up** drove the VM's load to 47 and etcd failed readiness for 10 minutes; Compose is stopped first now.
- **Held:**
  - The edge refuses a client's `traceparent`, so every trace starts at the edge.
  - The previous release's images ignored every new variable (`OTEL_*`, `TENANT_CONTEXT_SECRET_NEXT`) through each rollout.
  - No pod restarted when the controller took over the nine Secrets: their values were unchanged.

## Memory

Measured 2026-10-15 05:15, calm (load 1.0), with every Phase 7 layer running; the Compose stack stopped.

| | Phase 6 | Phase 7 |
|---|---|---|
| Colima VM used / available | 5,340 / 2,581 MiB | 5,420 / 2,501 MiB |
| k3d node | 4,067 MiB | 5,029 MiB |
| Cells (pool-1, canary, dedicated-1) | 229, 224, 200 MiB | 273, 273, 257 MiB |
| Edge / `platform-dev` | 41 / 152 MiB | 49 / 172 MiB |
| Argo CD | 552 MiB | 568 MiB |
| Monitoring | 1,044 MiB | 1,604 MiB: Tempo 264, Alloy 120, Loki 119 |
| Sealed Secrets controller | – | 28 MiB |

The new layers cost about 560 MiB in monitoring and 28 MiB in `kube-system`, with tracing adding a little to every unit. The VM keeps 2.5 GB available; CPU, not memory, was the limit this phase.

## Gaps and follow-ups

- Logs and traces are kept 24 h on the one node (decision 1); the scalable modes and object storage come with the cloud run.
- Manifest policies run in CI only; an admission controller would also stop a manifest applied by hand (decision 4). The upstream kube-prometheus-stack and Argo CD charts are not checked.
- The storefront's own log lines do not carry trace ids yet.
- The rotation tool counts its probe from its start rather than from the merge, and local `main` must be fast-forwarded over the files a step re-sealed.
- Database passwords are not rotated (decision 2's alternative).
- From earlier phases:
  - the synthetic prober's interval from each round's start;
  - a CI check that applies manifests to a scratch cluster;
  - an alert for a release stuck in wave 0;
  - a second edge replica;
  - a moved shop's Order links and sessions.
