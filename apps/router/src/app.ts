import replyFrom, { type FastifyReplyFromHooks } from "@fastify/reply-from";
import Fastify, { type FastifyServerOptions } from "fastify";
import { Counter, type Registry } from "prom-client";
import { loggingOptions, observeRequests } from "@shop/service-kit";
import { limitClassOf, planLimits, signTenantContext, tenantContextHeader } from "@shop/tenancy";
import { type Limit, RateLimiter } from "./rate-limit.ts";
import type { RouteSource } from "./routes.ts";
import type { UpstreamFor } from "./upstreams.ts";

export interface AppDeps {
  environment: string;
  routes: RouteSource;
  baseDomain: string;
  /** The storefront and tenant-context secret of an active shop's cell. */
  upstreamFor: UpstreamFor;
  /** The control plane's public listener (signup pages), served at the bare base domain. */
  platformPublicUrl: string;
  /** Where request durations are recorded; served by the private operational listener. */
  registry: Registry;
  /**
   * Shop handles never rate limited, and `platform` for the platform's own address: empty in the
   * cluster. The Compose test stack exempts the seeded shops and the signup pages, which its suites
   * drive far harder than any buyer; every other shop gets its plan's limits there too.
   */
  rateLimitExempt: ReadonlySet<string>;
}

/** Answered for every host that names no shop, identical whatever the host, so it reveals nothing. */
const noShop = "No shop at this address.\n";
const beingSetUp = "This shop is being set up. Try again in a few seconds.\n";
const unavailable = "This shop is temporarily unavailable.\n";
const starting = "The platform is starting. Try again in a few seconds.\n";
const upstreamDown = "This service is temporarily unavailable. Try again in a few seconds.\n";
const slowDown = (seconds: number) => `Too many requests to this shop. Try again in ${seconds} s.\n`;

/**
 * The shop handle a Host header names: the single label in front of the base domain
 * (`harbor.shop.localhost:8080` → `harbor`). Undefined for the bare base domain, deeper
 * subdomains, and any other host.
 */
export function handleFor(host: string | undefined, baseDomain: string): string | undefined {
  if (!host) return undefined;
  const name = host.toLowerCase().replace(/:\d+$/, "");
  const suffix = `.${baseDomain}`;
  if (!name.endsWith(suffix)) return undefined;
  const label = name.slice(0, -suffix.length);
  return label === "" || label.includes(".") ? undefined : label;
}

/** True for the bare base domain (`shop.localhost:8080`): the platform's own address. */
export function isPlatformHost(host: string | undefined, baseDomain: string): boolean {
  return host?.toLowerCase().replace(/:\d+$/, "") === baseDomain;
}

/**
 * The edge: resolves the request's host to a tenant and proxies the request to the storefront of
 * the tenant's cell with a tenant context freshly signed for that cell. A context sent by the client is dropped, so
 * the only tenant anything downstream believes is the one the router chose. Only an active shop
 * is proxied; one being set up or suspended, or whose cell this router cannot use, gets a fixed
 * page, and a deleted one is unknown. The
 * bare base domain goes to the control plane's signup pages, without any tenant context.
 */
export function buildApp(deps: AppDeps) {
  // One proxy (Traefik) in front of the edge in the cluster: the address it adds to
  // X-Forwarded-For is the client's, which the platform domain's rate limit is keyed by.
  const options: FastifyServerOptions = { ...loggingOptions("router", deps.environment), trustProxy: (_address, hop) => hop < 1 };
  const app = Fastify(options);
  observeRequests(app, deps.registry);
  const proxied = new Counter({
    name: "router_proxied_requests_total",
    help: "Requests proxied to a cell's storefront, by cell",
    labelNames: ["cell"] as const,
    registers: [deps.registry],
  });
  const rateLimited = new Counter({
    name: "router_rate_limited_total",
    help: "Requests refused with 429 for going over the shop's rate quota (by tenant), or a client's at the platform's address",
    labelNames: ["cell", "tenant"] as const,
    registers: [deps.registry],
  });
  const limiter = new RateLimiter();
  setInterval(() => limiter.sweep(), 30_000).unref();
  const unlimited: Limit = { rate: Number.POSITIVE_INFINITY, burst: Number.POSITIVE_INFINITY };
  const limitFor = (exemptAs: string, limit: { requestsPerSecond: number; burst: number }): Limit =>
    deps.rateLimitExempt.has(exemptAs) ? unlimited : { rate: limit.requestsPerSecond, burst: limit.burst };
  const unroutable = new Counter({
    name: "router_unroutable_requests_total",
    help: "Requests for an active shop whose cell this router cannot use, by reason",
    labelNames: ["reason"] as const,
    registers: [deps.registry],
  });

  // Bodies stream through untouched, whatever their content type: the storefront parses them.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

  // No fixed base: requests go either to the storefront or to the control plane's signup pages.
  app.register(replyFrom, {
    undici: { headersTimeout: 15_000, bodyTimeout: 30_000 },
    // Its own log lines record the full upstream URL, query string included, and Order links
    // carry their Order token there (ADR-0004). Fastify's own request lines are enough.
    disableRequestLogging: true,
  });

  const text = "text/plain; charset=utf-8";
  // An unreachable storefront or signup listener is a dependency outage: 503 with a fixed body,
  // not reply-from's generic 500, and the reason in the log rather than the response.
  const onError: NonNullable<FastifyReplyFromHooks["onError"]> = (reply, { error }) => {
    reply.log.warn({ err: error }, "upstream unavailable");
    reply.code(503).header("retry-after", "5").type(text).send(upstreamDown);
  };
  app.all("/*", async (req, reply) => {
    if (isPlatformHost(req.headers.host, deps.baseDomain)) {
      // The signup pages name no shop: each client address gets a starter shop's rate.
      const decision = limiter.take(`client:${req.ip}`, limitFor("platform", planLimits.starter));
      if (!decision.allowed) {
        rateLimited.inc({ cell: "", tenant: "" });
        return reply.code(429).header("retry-after", String(decision.retryAfterSeconds)).type(text).send(slowDown(decision.retryAfterSeconds));
      }
      return reply.from(`${deps.platformPublicUrl}${req.url}`, {
        onError,
        rewriteRequestHeaders: (_original, headers) => {
          const { [tenantContextHeader]: _fromClient, ...rest } = headers;
          return { ...rest, host: req.headers.host, "x-request-id": req.id };
        },
      });
    }
    if (!deps.routes.ready()) return reply.code(503).header("retry-after", "5").type(text).send(starting);
    const handle = handleFor(req.headers.host, deps.baseDomain);
    const tenant = handle === undefined ? undefined : deps.routes.lookup(handle);
    switch (tenant?.status) {
      case "ACTIVE":
        break;
      case "PROVISIONING":
        return reply.code(503).header("retry-after", "5").type(text).send(beingSetUp);
      case "SUSPENDED":
        return reply.code(503).type(text).send(unavailable);
      default:
        // Unknown, being deleted, or deleted: indistinguishable from an address that never named a shop.
        return reply.code(404).type(text).send(noShop);
    }

    // The shop's rate quota (Phase 5): over it, the request never reaches the cell.
    const decision = limiter.take(`tenant:${tenant.id}`, limitFor(tenant.handle, planLimits[limitClassOf(tenant)]));
    if (!decision.allowed) {
      rateLimited.inc({ cell: tenant.cell ?? "", tenant: tenant.handle });
      return reply.code(429).header("retry-after", String(decision.retryAfterSeconds)).type(text).send(slowDown(decision.retryAfterSeconds));
    }

    const upstream = deps.upstreamFor(tenant);
    if (typeof upstream === "string") {
      unroutable.inc({ reason: upstream });
      req.log.warn({ tenant: tenant.handle, cell: tenant.cell, reason: upstream }, "shop's cell unusable from this router");
      return reply.code(503).header("retry-after", "5").type(text).send(unavailable);
    }
    proxied.inc({ cell: upstream.cell });

    // The "request completed" line then names the shop and the cell the request was routed to.
    reply.log = req.log = req.log.child({ tenant: tenant.handle, cell: upstream.cell });
    return reply.from(`${upstream.storefrontUrl}${req.url}`, {
      onError,
      rewriteRequestHeaders: (_original, headers) => {
        const { [tenantContextHeader]: _fromClient, ...rest } = headers;
        return {
          ...rest,
          // The storefront compares a form post's Origin with Host, so Host must be the shop's.
          host: req.headers.host,
          // One id follows the request through the storefront and the APIs' logs.
          "x-request-id": req.id,
          [tenantContextHeader]: signTenantContext({ ...tenant, plan: limitClassOf(tenant) }, upstream.tenantContextSecret),
        };
      },
    });
  });

  return app;
}
