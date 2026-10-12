import replyFrom, { type FastifyReplyFromHooks } from "@fastify/reply-from";
import Fastify from "fastify";
import type { Registry } from "prom-client";
import { loggingOptions, observeRequests } from "@shop/service-kit";
import { signTenantContext, tenantContextHeader } from "@shop/tenancy";
import type { RouteSource } from "./routes.ts";

export interface AppDeps {
  environment: string;
  routes: RouteSource;
  baseDomain: string;
  storefrontUrl: string;
  /** The control plane's public listener (signup pages), served at the bare base domain. */
  platformPublicUrl: string;
  tenantContextSecret: string;
  /** Where request durations are recorded; served by the private operational listener. */
  registry: Registry;
}

/** Answered for every host that names no shop, identical whatever the host, so it reveals nothing. */
const noShop = "No shop at this address.\n";
const beingSetUp = "This shop is being set up. Try again in a few seconds.\n";
const unavailable = "This shop is temporarily unavailable.\n";
const starting = "The platform is starting. Try again in a few seconds.\n";
const upstreamDown = "This service is temporarily unavailable. Try again in a few seconds.\n";

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
 * The cell's edge: resolves the request's host to a tenant and proxies the request to the
 * storefront with a freshly signed tenant context. A context sent by the client is dropped, so
 * the only tenant anything downstream believes is the one the router chose. Only an active shop
 * is proxied; one being set up or suspended gets a fixed page, and a deleted one is unknown. The
 * bare base domain goes to the control plane's signup pages, without any tenant context.
 */
export function buildApp(deps: AppDeps) {
  const app = Fastify(loggingOptions("router", deps.environment));
  observeRequests(app, deps.registry);

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

    // The "request completed" line then names the shop the request was routed to.
    reply.log = req.log = req.log.child({ tenant: tenant.handle });
    return reply.from(`${deps.storefrontUrl}${req.url}`, {
      onError,
      rewriteRequestHeaders: (_original, headers) => {
        const { [tenantContextHeader]: _fromClient, ...rest } = headers;
        return {
          ...rest,
          // The storefront compares a form post's Origin with Host, so Host must be the shop's.
          host: req.headers.host,
          // One id follows the request through the storefront and the APIs' logs.
          "x-request-id": req.id,
          [tenantContextHeader]: signTenantContext(tenant, deps.tenantContextSecret),
        };
      },
    });
  });

  return app;
}
