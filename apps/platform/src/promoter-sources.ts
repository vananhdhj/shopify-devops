// What the promoter reads and calls (Phase 4): Argo CD's cell Applications through the Kubernetes
// API, a cell's metrics from Prometheus, a synthetic Checkout through the edge, and GitHub's
// workflow dispatch. Each endpoint is configurable so the Compose tests can point it at a stub.
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { CellState, Release } from "./promotion-gate.ts";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface Call {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Extra CA for https (the in-cluster API server's). */
  ca?: Buffer;
}

/** One HTTP(S) request with Node's own client: `fetch` can neither set Host nor take a CA. */
function call(url: string, { method = "GET", headers = {}, body, timeoutMs = 10_000, ca }: Call = {}): Promise<Reply> {
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      {
        method,
        host: target.hostname,
        port: target.port ? Number(target.port) : undefined,
        path: target.pathname + target.search,
        headers: { ...headers, ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }) },
        timeout: timeoutMs,
        ...(ca ? { ca } : {}),
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`${method} ${url} timed out`)));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const serviceAccountDir = "/var/run/secrets/kubernetes.io/serviceaccount";
const readIfPresent = (path: string) => {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
};

export interface ArgoSource {
  /** The Kubernetes API: in the cluster, its own service account's; in Compose, a stub. */
  apiUrl: string;
  namespace: string;
  /** Only images under this prefix make up a release (the platform's own, not Postgres or Redis). */
  imagePrefix: string;
}

interface ApplicationList {
  items: {
    metadata: { name: string; labels?: Record<string, string> };
    spec: { destination: { namespace?: string } };
    status?: { sync?: { status?: string }; health?: { status?: string }; summary?: { images?: string[] } };
  }[];
}

/** Every cell Application (labelled with its wave), as the promoter's view of the fleet. */
export async function cellStates({ apiUrl, namespace, imagePrefix }: ArgoSource): Promise<CellState[]> {
  const token = readIfPresent(`${serviceAccountDir}/token`)?.toString().trim();
  const reply = await call(
    `${apiUrl}/apis/argoproj.io/v1alpha1/namespaces/${namespace}/applications?labelSelector=${encodeURIComponent("shop.example/wave")}`,
    { headers: token ? { authorization: `Bearer ${token}` } : {}, ca: readIfPresent(`${serviceAccountDir}/ca.crt`) },
  );
  if (reply.status !== 200) throw new Error(`listing Applications answered ${reply.status}`);
  const list = JSON.parse(reply.body) as ApplicationList;
  return list.items.map((app) => {
    const release: Release = {};
    for (const image of app.status?.summary?.images ?? []) {
      const [name, digest] = image.split("@");
      if (name?.startsWith(imagePrefix) && digest?.startsWith("sha256:")) release[name] = digest;
    }
    return {
      cell: app.metadata.labels?.["shop.example/cell"] ?? app.metadata.name,
      wave: Number(app.metadata.labels?.["shop.example/wave"]),
      namespace: app.spec.destination.namespace ?? "",
      synced: app.status?.sync?.status === "Synced",
      healthy: app.status?.health?.status === "Healthy",
      release,
    };
  });
}

/** One instant query; null when Prometheus has no sample (no traffic, no Pending Order). */
async function instant(prometheusUrl: string, query: string): Promise<number | null> {
  const reply = await call(`${prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}`);
  if (reply.status !== 200) throw new Error(`Prometheus answered ${reply.status}`);
  const result = (JSON.parse(reply.body) as { data: { result: { value: [number, string] }[] } }).data.result;
  const value = result[0] ? Number(result[0].value[1]) : null;
  return value === null || Number.isNaN(value) ? null : value;
}

const served = 'route!~"/health/.*|/metrics"';

/** A cell's error ratio, oldest Pending Order, and firing alerts, the gate's metrics. */
export async function cellMetrics(prometheusUrl: string, namespace: string) {
  const ns = `namespace="${namespace}"`;
  const [errorRatio, oldestPendingSeconds, firingAlerts] = await Promise.all([
    instant(
      prometheusUrl,
      `sum(rate(http_request_duration_seconds_count{${ns},status_code=~"5..",${served}}[2m])) / sum(rate(http_request_duration_seconds_count{${ns},${served}}[2m]))`,
    ),
    instant(prometheusUrl, `max(orders_oldest_pending_age_seconds{${ns}})`),
    instant(prometheusUrl, `count(ALERTS{alertstate="firing",${ns}})`),
  ]);
  return { errorRatio, oldestPendingSeconds, firingAlerts: firingAlerts ?? 0 };
}

export interface EdgeTarget {
  edgeUrl: string;
  baseDomain: string;
}

/** Cookies set by a reply, as one Cookie header value (name=value pairs only). */
function cookiesOf(reply: Reply, previous: string): string {
  const set = reply.headers["set-cookie"] ?? [];
  const jar = new Map(previous ? previous.split("; ").map((pair) => pair.split("=", 2) as [string, string]) : []);
  for (const cookie of Array.isArray(set) ? set : [set]) {
    const [pair] = cookie.split(";");
    const [name, ...value] = pair!.split("=");
    jar.set(name!.trim(), value.join("="));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

const terminal = new Set(["Confirmed", "Rejected", "Fulfilled", "Cancelled"]);

/**
 * Buys the synthetic shop's first product through the edge as a guest would, with the decline
 * payment scenario (Stock is deducted and released again), and waits up to `settleMs` for the
 * Order to leave Pending. True when it did: every unit of the cell took part (storefront, catalog,
 * orders, the worker's settlement).
 */
export async function syntheticCheckout({ edgeUrl, baseDomain }: EdgeTarget, handle: string, settleMs = 30_000): Promise<boolean> {
  const host = `${handle}.${baseDomain}`;
  const form = { "content-type": "application/x-www-form-urlencoded" };
  const at = (path: string) => `${edgeUrl}${path}`;
  const id = `promoter-synthetic-${handle}`;

  const home = await call(at("/"), { headers: { host, "x-request-id": id } });
  const product = /name="productId" value="([0-9a-f-]{36})"/.exec(home.body)?.[1];
  if (home.status !== 200 || !product) return false;

  let cookies = "";
  const added = await call(at("/cart/items"), {
    method: "POST",
    headers: { host, ...form, "x-request-id": id },
    body: `productId=${product}&action=add`,
  });
  cookies = cookiesOf(added, cookies);
  const checkout = await call(at("/checkout"), { headers: { host, cookie: cookies, "x-request-id": id } });
  const key = /name="checkoutKey" value="([^"]+)"/.exec(checkout.body)?.[1];
  if (!key) return false;
  const placed = await call(at("/orders"), {
    method: "POST",
    headers: { host, ...form, cookie: cookies, "x-request-id": id },
    body: `checkoutKey=${encodeURIComponent(key)}&paymentScenario=decline`,
  });
  const location = placed.headers.location;
  if (typeof location !== "string" || !location.includes("/orders/")) return false;
  const order = new URL(location, `http://${host}`);

  const deadline = Date.now() + settleMs;
  while (Date.now() < deadline) {
    const page = await call(at(order.pathname + order.search), { headers: { host, "x-request-id": id } });
    const status = /Status: (?:<!-- -->)?([A-Za-z]+)/.exec(page.body)?.[1];
    if (status && terminal.has(status)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

export interface GitHubTarget {
  apiUrl: string;
  repository: string;
  token: string;
}

/** Asks GitHub to run the promote workflow for `wave` with the gated release (ADR-0003: it commits). */
export async function dispatchPromotion({ apiUrl, repository, token }: GitHubTarget, wave: number, release: Release, gate: string) {
  const reply = await call(`${apiUrl}/repos/${repository}/actions/workflows/promote.yml/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
      "user-agent": "shop-platform-promoter",
    },
    body: JSON.stringify({ ref: "main", inputs: { wave: String(wave), digests: JSON.stringify(release), gate } }),
  });
  if (reply.status !== 204) throw new Error(`dispatching promote answered ${reply.status}: ${reply.body.slice(0, 200)}`);
}
