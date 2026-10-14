import {
  type Attributes,
  type Context,
  context,
  INVALID_SPAN_CONTEXT,
  isSpanContextValid,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Traces (Phase 7): one trace follows a buyer's request from the edge through the storefront, the
 * APIs, the outbox, and the queue to the Order's settlement. Spans are made by hand at those
 * hops (no auto-instrumentation): every Fastify request, every call to another unit, every
 * database transaction, and the queue's two ends. W3C trace context travels in `traceparent`.
 *
 * Off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set: then every span call is a no-op. Resource
 * attributes come from `OTEL_RESOURCE_ATTRIBUTES` too (each cell sets `cell=…`).
 */
let provider: NodeTracerProvider | undefined;

export function startTracing(service: string, environment: string): void {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT || provider) return;
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": service, "deployment.environment.name": environment }).merge(
      detectResources({ detectors: [envDetector] }),
    ),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register({ contextManager: new AsyncLocalStorageContextManager(), propagator: new W3CTraceContextPropagator() });
}

/** Sends the spans still buffered; on shutdown (`runService` calls it). */
export async function stopTracing(): Promise<void> {
  await provider?.shutdown().catch(() => {});
}

const tracer = () => trace.getTracer("@shop/service-kit");

/** Probes and scrapes make no spans: they would drown a trace search. */
const untraced = (url: string | undefined) => url === undefined || url.startsWith("/health") || url === "/metrics";

/**
 * A server span for every request, named by route template (never the raw URL: tokens live in
 * paths and query strings), continuing the caller's trace when `trustCaller` (inside the
 * platform) and starting a new one otherwise (the edge, facing the internet). The rest of the
 * request runs inside it, so its log lines, database spans, and calls out belong to it.
 */
export function traceRequests(app: FastifyInstance, { trustCaller = true }: { trustCaller?: boolean } = {}): void {
  const spans = new WeakMap<FastifyRequest, Span>();
  app.addHook("onRequest", (req, reply, done) => {
    const route = req.routeOptions.url;
    if (untraced(route)) return done();
    const parent = trustCaller ? propagation.extract(ROOT_CONTEXT, req.headers) : ROOT_CONTEXT;
    const span = tracer().startSpan(
      `${req.method} ${route}`,
      { kind: SpanKind.SERVER, attributes: { "http.request.method": req.method, "http.route": route ?? "", "request.id": req.id } },
      parent,
    );
    spans.set(req, span);
    // Fastify writes "request completed" outside the request's async context: bind the ids.
    const ids = span.spanContext();
    if (isSpanContextValid(ids)) reply.log = req.log = req.log.child({ traceId: ids.traceId, spanId: ids.spanId });
    context.with(trace.setSpan(parent, span), done);
  });
  app.addHook("onResponse", (req, reply, done) => {
    const span = spans.get(req);
    if (span) {
      span.setAttribute("http.response.status_code", reply.statusCode);
      if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    }
    done();
  });
}

/**
 * Runs `work` in a new span, a child of `parent` (default: the current span), and ends it,
 * recording a thrown error. Every span call is a no-op while tracing is off. `onlyInTrace` makes
 * no span outside a trace (a background loop's database work would otherwise start a trace a tick).
 */
export async function withSpan<T>(
  name: string,
  options: { kind?: SpanKind; attributes?: Attributes; parent?: Context; onlyInTrace?: boolean },
  work: (span: Span) => Promise<T>,
): Promise<T> {
  const parent = options.parent ?? context.active();
  if (options.onlyInTrace && !trace.getSpan(parent)) return work(trace.wrapSpanContext(INVALID_SPAN_CONTEXT));
  const span = tracer().startSpan(name, { kind: options.kind ?? SpanKind.INTERNAL, attributes: options.attributes }, parent);
  return context.with(trace.setSpan(parent, span), async () => {
    try {
      return await work(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** The current trace context as headers for a call to another unit (`traceparent`, `tracestate`). */
export function traceHeaders(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** The current trace context as one string to store (the outbox row, the queue job); undefined when not tracing. */
export function currentTraceContext(): string | undefined {
  return traceHeaders().traceparent;
}

/** The context a stored `traceparent` names, to continue its trace; the root context when there is none. */
export function contextFrom(traceparent: string | null | undefined): Context {
  return traceparent ? propagation.extract(ROOT_CONTEXT, { traceparent }) : ROOT_CONTEXT;
}

/** Marks the current span with an attribute, for instance the shop or the Order it is about. */
export function annotateSpan(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}

/** The current trace and span ids, for a log line; empty when not tracing. */
export function traceIds(): { traceId?: string; spanId?: string } {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && isSpanContextValid(spanContext) ? { traceId: spanContext.traceId, spanId: spanContext.spanId } : {};
}

export { SpanKind } from "@opentelemetry/api";
