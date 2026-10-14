# 03: One trace from the edge to the settlement, in Tempo

**What to build:** OpenTelemetry in the edge, the storefront, the catalog API, the order service, and the worker; W3C trace context over HTTP, through the outbox row, and into the BullMQ job; Tempo single-binary (24 h) behind Alloy's OTLP receiver; log lines carry the trace id (decision 1).

**Blocked by:** 02

**Status:** in review

- [x] SDK set-up shared in `@shop/service-kit` (and the storefront's instrumentation): HTTP server and client, PostgreSQL; spans carry `tenant.id` and `cell`; `OTEL_EXPORTER_OTLP_ENDPOINT` unset means no export
- [x] Migration (expand only): `orders.outbox.trace_context`; the order service writes it with the Order, the dispatcher puts it into the job, the worker's settlement span links to it
- [x] Every log line gains `traceId` (and `spanId`)
- [x] Tempo in `deploy/monitoring`, the Grafana datasource, trace ↔ logs links
- [x] Compose `--profile tracing` with Tempo; test: a Checkout gives one trace with spans from the edge to the worker, and its log lines carry its id
- [ ] Cluster: `make experiment-trace` finds a Checkout's trace by its Order id

## Comments

Implementation notes (2026-10-14):
- **Spans by hand, not auto-instrumentation** (`packages/service-kit/src/tracing.ts`). The units are ESM, and patching `pg` or `http` there needs a loader hook. Instead, spans are made at the hops that matter:
  - a server span per Fastify request, named by route template, never the raw URL (`traceRequests`);
  - a client span per call to another unit, with `traceparent` (`withSpan`, `traceHeaders`);
  - a span per database transaction, only inside a trace: the dispatcher's tick would otherwise start a trace every quarter second;
  - the queue's producer and consumer.

  `@opentelemetry/api` 1.9.1, SDK 2.12.0, OTLP/HTTP exporter 0.223.0. Off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set (every call a no-op); `runService` flushes on shutdown.
- **The path of a Checkout**:
  - the edge (`trustCaller: false`: a client's `traceparent` and `tracestate` are dropped, and every request starts its trace there; the span names the shop and its cell);
  - the storefront (Next.js makes its own spans once `instrumentation.ts` registers a provider, and continues the edge's context; `backendFetch` passes it on);
  - the order service (`POST /checkout`, its Cart fetch, its transactions; the span names the shop and the Order);
  - the outbox: migration `20261014000110` adds `orders.outbox.trace_context`, written with the Order, and `orders.event_trace_contexts(uuid[])`, a narrow function the dispatcher reads it back through;
  - the worker's `outbox dispatch` (producer), whose context goes into the BullMQ job;
  - the worker's `settle order` (consumer), and its inventory calls to the catalog API.

  A job that reconciliation re-enqueues starts its own trace.
- **Logs**: every line inside a trace carries `traceId` and `spanId`. A request's logger has them bound (Fastify writes "request completed" outside the request's async context); other lines take them from the current span through a pino mixin. No key is written twice. The storefront's own lines do not carry them yet.
- **Cluster**:
  - Tempo 2.9.0 as plain manifests in `deploy/monitoring/config/tempo.yaml`: a StatefulSet, local storage on a 2 Gi PVC, 24 h, 256 Mi limit, `GOMEMLIMIT` 200 MiB, non-root with a read-only root filesystem. The single-binary chart is deprecated, and plain manifests are checked by the policies like the repository's own.
  - Alloy receives OTLP/HTTP on 4318 (a port on its Service), batches, and exports to Tempo over gRPC.
  - Grafana: a Tempo datasource (node graph; a span opens its trace's log lines in Loki) and a Loki derived field (a line's `traceId` opens its trace).
  - Every cell's `shop-env` sets `OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy.monitoring.svc:4318` and `OTEL_RESOURCE_ATTRIBUTES=cell=<cell>`; the dev edge sets the endpoint. Images of the previous release ignore both.
- **Compose**: Tempo 2.9.0 as a service (memory-backed, an hour, query API on `127.0.0.1:3200`), and every unit of both cells exporting to it.
- `make experiment-trace [HANDLE=…]`: a Checkout through the ingress, its trace found by the Order id (TraceQL `{ span.order.id = "…" }`), its spans printed in start order with unit, cell, and duration.

Tests (`traces.test.ts`, Compose):
- **One trace**: a Checkout through the edge is found in Tempo by its Order id, with spans from exactly the router, the storefront, the order service, the catalog API, and the worker. Among them:
  - `POST /checkout` naming Harbor and the Order;
  - the producer `outbox dispatch` and the consumer `settle order` ("confirmed");
  - the catalog's `GET /carts/:id` and `POST /internal/inventory-effects`;
  - the edge's `POST /*` naming Harbor and pool-1;
  - the order service's database transactions.
- **Trace ids in logs**: the edge's and the catalog API's lines for one request carry the same trace id.
- **A forged `traceparent`**: one sent by a client is not continued.

Found on the way:
- `compose logs` of a unit over a full suite passed Node's 1 MB `execFileSync` buffer once the lines carried trace ids (ENOBUFS in three tests); the helper's buffer is now 64 MB.
- `settle.test.ts`'s slow payment measured 2.94 s against its 3 s delay in one full run with the VM's load averaging 7.4 (2.83 s once before, in ticket 04, without tracing); it passed alone. Both timestamps come from PostgreSQL, so it looks like the VM's clock under load; a load-sensitive flake.
- Restarting the cluster with the Compose stack still up drove the VM's load to 47, and etcd failed readiness for 10 minutes; it recovered once Compose was stopped. Compose is stopped first now.

`make test CELLS=2` with the cluster stopped: 48 files, 248 tests passed, with the one flake above. A server-side dry-run of the monitoring config, every cell, the edge, and Alloy against the lab cluster passed (each cell's migration Job aside, immutable as always). `make policy`: 1,936 checks.
