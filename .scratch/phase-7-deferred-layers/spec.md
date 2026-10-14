# Spec: Phase 7 — the deferred layers

**Status:** ready-for-agent (decisions 1–3 approved by the author on 2026-10-14; decision 4 is the default the spec proposes; tickets under `issues/`)

Background: the blueprint (`~/workspace/Research/narrow/Shopify DevOps Portfolio Blueprint.md`) puts Phase 7 after tenant data operations: "Deferred layers from the October 8 plan: Alloy/Loki, OpenTelemetry/Tempo, Conftest, Sealed Secrets, HPA". The exit gate is "Follow one tenant's order across router, cell, and queue in traces; bad manifest blocked; secret rotation rehearsed". Its observability section adds:
- structured JSON logs with `tenant_id`, `cell`, request ID, and trace ID;
- W3C trace context through the router, the APIs, and the queue payload;
- never logging Order tokens, Merchant credentials, or customer payloads.

Its DevSecOps section carries forward manifest policies (no privileged or root containers, resource bounds, approved registries) and Sealed Secrets with a rehearsed rotation. Phases 1–6 are resolved; ADRs 0001–0030 are binding.

Lessons that shape this phase:
- The laptop's memory is the lab's limit (Phases 3–6). The VM has 8 GB, and about 2.5 GB was available at the end of Phase 6.
- Per-tenant limits live in each unit's memory (ADR-0026), so a unit with in-memory limits cannot simply gain replicas.
- Each cell signs and checks its own tenant context with its own secret (ADR-0011). A secret change has to work with the previous release and through the waves, like a schema change (ADR-0021).

## Problem Statement

- **Following one request is guesswork.** Logs exist per pod and per Compose container, but nothing ties a buyer's Checkout at the edge to the order service's write, the dispatcher's claim, and the worker's settlement. "Why did this shop's Order take 4 s?" is answered by grepping several pods by request id, and the queue hop loses even that.
- **Logs vanish with their pod.** A restarted or rolled pod's lines are gone, and nothing searches across cells or shops.
- **A bad manifest reaches the cluster** if it renders and passes the schema check. A privileged container, a missing memory limit, or an image from an unknown registry is caught by nobody before Argo CD syncs it (#54's StatefulSet error was found only on the cluster).
- **Secrets are applied by hand.** `make secrets` copies them into the cluster from the laptop, outside Git. A new cluster cannot be rebuilt from the repository alone, and no secret has ever been changed in a running cell.
- **Every unit runs one replica**, whatever its load.

## Solution

- **Logs**: one Alloy agent collects every pod's JSON log lines into Loki. They are searchable in Grafana by namespace, cell, and unit, and inside a line by `tenant_id`, `requestId`, and `traceId`.
- **Traces**: OpenTelemetry in the edge, the storefront, the catalog API, the order service, and the worker. W3C trace context goes over HTTP, through the outbox row, and into the BullMQ job. One trace follows a buyer's Checkout from the edge to its settlement, stored in Tempo and linked both ways with its log lines.
- **Manifest policy**: Conftest (Rego) checks every rendered manifest in CI, and a violation fails the pull request:
  - no privileged containers, root users, or privilege escalation;
  - memory limits and CPU and memory requests on every container;
  - images only from the project's registry (and the pinned third-party charts' registries), by digest or pinned tag, never `latest`.
- **Sealed Secrets**: the controller decrypts SealedSecrets that live in Git, per namespace. `make secrets` still generates the values on the laptop (and for Compose), and now seals the cluster's copy for commit. A rotation of one cell's tenant-context secret is rehearsed with no downtime.
- **Autoscaling**: a HorizontalPodAutoscaler on the stateless units of the pooled cell.

## Decisions (approved 2026-10-14)

1. **Logs and traces, lean.** One Alloy agent (logs and OTLP), Loki and Tempo each single-binary on local disk with 24 h retention, each about 256 MiB at most (around 0.8 GB in all). It fits the laptop; retention and scale change in the cloud run (Phase 8).
   - Alternatives: traces only, with logs kept in `kubectl` (about 0.3 GB): rejected, logs are half the value of a trace id. Full retention of 7 days (about 1.5 GB): rejected, it would leave under 1 GB and invite Phase 5's memory stalls.
2. **The rotation drill rotates one cell's tenant-context secret with no downtime.** The cell's units accept the current secret and a next one. Then the edge signs with the next. Then the next becomes the only one: an expand/contract for a secret.
   - Alternative: a database password with a restart. Simpler, but a restart window and less to learn; it stays possible later.
3. **Autoscaling only for units with no per-tenant state in memory**: the storefront and the catalog API in pool-1 (the product quota is counted in the database).
   - The edge and the order service stay at one replica, and ADR-0026 is unchanged.
   - Alternative: shared limits in Redis so every unit scales: rejected again (Phase 5, decision 3), a new dependency on every request.
4. **Manifest policies run in CI, not in the cluster** (proposed default). Conftest checks the rendered manifests of every Application on every pull request, and the pull request is blocked.
   - Alternative: an admission controller (Kyverno or Gatekeeper) that also stops a manifest applied by hand. Rejected for now: a few hundred MiB for a lab where nothing is applied by hand except bootstrap. Noted in the README as the change for a shared cluster.

## User Stories

1. As the platform operator, given a shop and an Order id, I open one trace that shows the edge, the storefront, the order service's Checkout, the outbox dispatch, and the worker's settlement, with each span's time and the shop's `tenant_id`.
2. As the platform operator, I search the last 24 h of logs for one shop, or one request, across every cell and unit, including pods that have since restarted.
3. As a reviewer, a pull request that adds a privileged container, drops a memory limit, or uses an image from an unknown registry fails CI and names the rule.
4. As the platform operator, I rebuild the cluster's secrets from Git (with the sealing key backed up), and I rotate one cell's tenant-context secret while its shops keep serving.
5. As the platform operator, pool-1's storefront and catalog API add replicas under load and drop them after.

## Implementation Decisions

- **Logs** (`deploy/monitoring`): Grafana Alloy as a DaemonSet, tailing pod logs through the Kubernetes API.
  - Labels: `namespace`, `cell` (from the pod label of Phase 5), `app`. Not `tenant_id` or request ids, which stay in the JSON and are queried with LogQL's `json` filter, keeping streams bounded.
  - Loki single-binary, filesystem storage on a PVC, 24 h retention, with a Grafana datasource.
  - Compose: unchanged (`docker logs`).
- **Traces**:
  - The OpenTelemetry Node SDK in each unit: HTTP server and client spans, and spans for PostgreSQL queries.
  - W3C `traceparent` from the edge to the storefront and the APIs. The outbox row gains `trace_context` (expand-only migration), which the dispatcher puts into the BullMQ job and the worker continues as a linked span.
  - Every log line gains `traceId`. Spans carry `tenant.id` and `cell` attributes.
  - Exported over OTLP to Alloy, then Tempo single-binary on local disk, 24 h, with a Grafana datasource that links trace ↔ logs.
  - Sampling: everything in the lab (`parentbased_always_on`), with the rate configurable.
  - Compose: an optional profile with Tempo, for the tests.
- **Conftest** (`policy/`, Rego):
  - rules: no privileged containers, root users, privilege escalation, or host network; memory limits and CPU and memory requests on every container; images only from `ghcr.io/vananhdhj/shopify-devops` or the pinned upstream charts' registries, never `:latest`; no Secret objects in Git except SealedSecrets;
  - a CI job over every Application's rendered output, with fixtures of bad manifests that must fail;
  - `make policy` runs it locally.
- **Sealed Secrets**:
  - the controller (pinned chart) in `kube-system`;
  - `make secrets` writes `deploy/**/sealed-*.yaml` with `kubeseal`, against the controller's public certificate, one SealedSecret per namespace as today's Secrets;
  - the controller's key is exported once to `.secrets/` (never Git), with a documented restore;
  - `scripts/cluster-secrets.sh` retires once every namespace's Secret is sealed (the switch waits until the sealed copies are deployed: dependencies first).
- **Tenant-context rotation**:
  - the cell's units accept `TENANT_CONTEXT_SECRET` and an optional `TENANT_CONTEXT_SECRET_NEXT`, verifying with either;
  - the edge signs with the cell's key file, which it re-reads;
  - `make rotate-tenant-context CELL=…` runs three steps, each sealed, committed, and waited on: add next; switch the edge; drop the old;
  - a probe through the ingress counts answers that are not 200 throughout.
- **HPA**: `autoscaling/v2` on CPU (70%) for pool-1's storefront and catalog API, from 1 to 3 replicas, with k3s's metrics-server; a scale-down stabilisation of 5 minutes. Every container already has requests (enforced by ticket 03).
- **Experiments** (`make experiment-trace`, the policy fixtures, `make rotate-tenant-context`, `make experiment-autoscale`), recorded in the evidence:
  - **Trace**: a Checkout of one shop, the trace found by its Order id, and its spans across the edge, the storefront, the order service, the dispatcher, and the worker.
  - **Bad manifest**: a pull request with a privileged container fails CI with the rule's name.
  - **Rotation**: dedicated-1's secret rotated with zero failed requests through the ingress.
  - **Autoscale**: k6 load on pool-1's storefront shows replicas rising and falling, with the VM's memory recorded.

## Testing Decisions

- Pure:
  - the policy fixtures (each rule has a passing and a failing manifest);
  - tenant-context verification with two secrets;
  - trace context through the outbox payload.
- Seam 1 (Compose, `--profile tracing`): a Checkout yields one trace with spans from the edge to the worker, and its log lines carry its trace id; a context signed with the next secret is accepted once the cell knows it.
- Seam 2 (lab cluster): the experiments.

## Out of Scope

- An admission controller (decision 4).
- Log and trace retention beyond 24 h, and storage off the node (Phase 8).
- Metrics from traces (span metrics, service graphs).
- Autoscaling the edge, the order service, the worker, or a dedicated cell (decision 3).
- Rotating database passwords (decision 2's alternative), and an external secret store such as Vault.
