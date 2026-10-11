import replyFrom from "@fastify/reply-from";
import Fastify from "fastify";
import type { Registry } from "prom-client";
import { loggingOptions, observeRequests } from "@shop/service-kit";
import { signTenantContext, tenantContextHeader, type Tenant } from "@shop/tenancy";

export interface AppDeps {
  environment: string;
  tenants: Tenant[];
  baseDomain: string;
  storefrontUrl: string;
  tenantContextSecret: string;
  /** Where request durations are recorded; served by the private operational listener. */
  registry: Registry;
}

/** Answered for every host that names no shop, identical whatever the host, so it reveals nothing. */
const noShop = "No shop at this address.\n";

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

/**
 * The cell's edge: resolves the request's host to a tenant and proxies the request to the
 * storefront with a freshly signed tenant context. A context sent by the client is dropped, so
 * the only tenant anything downstream believes is the one the router chose.
 */
export function buildApp(deps: AppDeps) {
  const tenantsByHandle = new Map(deps.tenants.map((tenant) => [tenant.handle, tenant]));
  const app = Fastify(loggingOptions("router", deps.environment));
  observeRequests(app, deps.registry);

  // Bodies stream through untouched, whatever their content type: the storefront parses them.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

  app.register(replyFrom, {
    base: deps.storefrontUrl,
    undici: { headersTimeout: 15_000, bodyTimeout: 30_000 },
    // Its own log lines record the full upstream URL, query string included, and Order links
    // carry their Order token there (ADR-0004). Fastify's own request lines are enough.
    disableRequestLogging: true,
  });

  app.all("/*", async (req, reply) => {
    const tenant = tenantsByHandle.get(handleFor(req.headers.host, deps.baseDomain) ?? "");
    if (!tenant) return reply.code(404).type("text/plain; charset=utf-8").send(noShop);

    // The "request completed" line then names the shop the request was routed to.
    reply.log = req.log = req.log.child({ tenant: tenant.handle });
    return reply.from(req.url, {
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
