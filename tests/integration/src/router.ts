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
