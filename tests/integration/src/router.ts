import { request } from "node:http";

export const routerPort = Number(process.env.ROUTER_PORT ?? 8000);
export const baseDomain = "shop.localhost";

/** The Host a shop is reached at through the router, e.g. `harbor.shop.localhost:8000`. */
export function shopHost(handle: string): string {
  return `${handle}.${baseDomain}:${routerPort}`;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * One HTTP request to the router with an explicit Host header. `fetch` always sends the URL's
 * host, so it cannot address a shop by name without DNS for `*.shop.localhost`; this can.
 */
export function viaRouter(
  host: string,
  path: string,
  { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: routerPort, method, path, headers: { ...headers, host }, timeout: 10_000 },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`router request to ${host}${path} timed out`)));
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * A `fetch`-shaped request to a shop's storefront through the router (Harbor Goods unless told
 * otherwise). Redirects are never followed, like `redirect: "manual"`.
 */
export async function shopFetch(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  handle = "harbor",
): Promise<Response> {
  const raw = await viaRouter(shopHost(handle), path, init);
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw.headers)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, one);
  }
  // A Response cannot carry a body with these statuses.
  const body = [204, 304].includes(raw.status) ? null : raw.body;
  return new Response(body, { status: raw.status, headers });
}
