// The autoscaling experiment (Phase 7, ticket 06), run by scripts/experiment-autoscale.sh. Several
// starter shops in pool-1 have their home page (the storefront renders it from the catalog API)
// asked for at RATE a second each, under their plan's 10, for DURATION, through the cluster's
// ingress from the k3d network, by Host header. The answers are counted by status.
import http from "k6/http";
import { Counter } from "k6/metrics";

const ingress = __ENV.INGRESS ?? "http://k3d-shop-serverlb:80";
const domain = __ENV.SHOP_DOMAIN ?? "shop.localhost";
const shops = (__ENV.SHOPS ?? "").split(",").filter(Boolean);
const rate = Number(__ENV.RATE ?? 8);
const duration = __ENV.DURATION ?? "4m";
const answers = new Counter("answers");

export const options = {
  discardResponseBodies: true,
  scenarios: Object.fromEntries(
    shops.map((shop) => [
      shop,
      { executor: "constant-arrival-rate", rate, timeUnit: "1s", duration, preAllocatedVUs: 8, maxVUs: 40, exec: "home", env: { SHOP: shop } },
    ]),
  ),
  // A threshold per tag makes k6 keep that submetric: the answers by class, and by the statuses
  // a slow or limited stack gives (0 is no answer within the timeout).
  thresholds: Object.fromEntries(
    ["class:2xx", "class:other", ...["0", "429", "500", "502", "503", "504"].map((s) => `status:${s}`)].map((tag) => [`answers{${tag}}`, ["count>=0"]]),
  ),
};

export function home() {
  const res = http.get(`${ingress}/`, { headers: { Host: `${__ENV.SHOP}.${domain}` }, timeout: "10s" });
  answers.add(1, { class: res.status >= 200 && res.status < 300 ? "2xx" : "other", status: String(res.status) });
}

export function handleSummary(data) {
  const count = (name) => data.metrics[name]?.values.count ?? 0;
  return {
    "/out/result.json": JSON.stringify({
      ok: count("answers{class:2xx}"),
      other: count("answers{class:other}"),
      byStatus: Object.fromEntries(["0", "429", "500", "502", "503", "504"].map((s) => [s, count(`answers{status:${s}}`)]).filter(([, n]) => n > 0)),
      p95: data.metrics.http_req_duration?.values["p(95)"] ?? null,
    }),
  };
}
