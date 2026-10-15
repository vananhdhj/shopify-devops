---
status: accepted
---

# Logs and traces are lean: one Alloy, single-binary Loki and Tempo, spans made by hand

Every pod's log lines and every unit's spans are kept 24 h on the lab's one node (Phase 7, decision 1, amended 2026-10-15):
- **Alloy**, one per node, reads the node's pod log files (`/var/log/pods`, read-only) and pushes them to Loki. It also receives the units' spans over OTLP/HTTP and passes them to Tempo.
- **Loki** (single-binary, filesystem, 256 MiB limit) and **Tempo** (single-binary, local storage, 512 MiB), each on a 2 Gi volume.
- **Stream labels** are the namespace, the cell, the app, and the pod (`instance`). The shop, the request, and the trace stay inside the JSON line, so streams are bounded by pods, not by shops.

**Traces** are made by hand in `@shop/service-kit`, not by auto-instrumentation, at the hops that matter:
- every request, as a server span;
- every call to another unit, as a client span carrying `traceparent`;
- every database transaction inside a trace;
- the queue's two ends.

A Checkout's trace context is stored on its outbox row and put into its queue job, so the settlement continues the Checkout's trace. The edge starts every trace and drops a client's `traceparent`. Every log line inside a trace carries its `traceId`.

## Considered Options

- **Traces only, logs left in `kubectl`**: rejected. A trace id is worth little without the lines around it, and a replaced pod's lines would be lost.
- **Longer retention, scalable modes**: rejected for now (about 1.5 GB). Deferred to the cloud run, as the README records.
- **Reading logs through the Kubernetes API, non-root**: the first version. Rejected after it reopened streams hundreds of times an hour, kept k3s at 200% CPU, and lost lines on reconnects. The agent now runs as root to read root-owned files, with every capability dropped and a read-only root filesystem: the manifest policies' one listed exception (ADR-0032).
- **OpenTelemetry auto-instrumentation**: rejected. Under ESM it needs loader hooks, and it spans every query and call, many more spans than the lab needs.

## Consequences

- About 1 GB for logs and traces (Phase 7 evidence), within the 8 GB VM's room.
- A trace follows an Order from the edge to its settlement (66 ms in the evidence). A job that reconciliation re-enqueues starts its own trace.
- Lines and spans older than 24 h, or lost with the node, are gone.
