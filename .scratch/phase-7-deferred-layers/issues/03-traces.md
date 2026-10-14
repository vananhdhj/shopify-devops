# 03: One trace from the edge to the settlement, in Tempo

**What to build:** OpenTelemetry in the edge, the storefront, the catalog API, the order service, and the worker; W3C trace context over HTTP, through the outbox row, and into the BullMQ job; Tempo single-binary (24 h) behind Alloy's OTLP receiver; log lines carry the trace id (decision 1).

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] SDK set-up shared in `@shop/service-kit` (and the storefront's instrumentation): HTTP server and client, PostgreSQL; spans carry `tenant.id` and `cell`; `OTEL_EXPORTER_OTLP_ENDPOINT` unset means no export
- [ ] Migration (expand only): `orders.outbox.trace_context`; the order service writes it with the Order, the dispatcher puts it into the job, the worker's settlement span links to it
- [ ] Every log line gains `traceId` (and `spanId`)
- [ ] Tempo in `deploy/monitoring`, the Grafana datasource, trace ↔ logs links
- [ ] Compose `--profile tracing` with Tempo; test: a Checkout gives one trace with spans from the edge to the worker, and its log lines carry its id
- [ ] Cluster: `make experiment-trace` finds a Checkout's trace by its Order id
