// The noisy-neighbour experiment (Phase 5, ticket 08), run by scripts/experiment-noisy-neighbour.sh.
// Three quiet starter shops in pool-1 each run one buyer journey a second (browse, add to cart,
// Checkout: four requests, under their plan's 10 a second) for the whole run; after the baseline,
// a fourth starter shop in the same cell is driven at 10x its rate quota. Reached through the
// cluster's ingress from the k3d network, by Host header.
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";

const ingress = __ENV.INGRESS ?? "http://k3d-shop-serverlb:80";
const domain = __ENV.SHOP_DOMAIN ?? "shop.localhost";
const quiet = (__ENV.QUIET ?? "").split(",").filter(Boolean);
const noisy = __ENV.NOISY;
const phase = __ENV.PHASE_DURATION ?? "5m";
const noisyRate = Number(__ENV.NOISY_RATE ?? 100);

const checkoutSeconds = new Trend("checkout_seconds", true);
const journeyFailures = new Counter("journey_failures");
const noisyResponses = new Counter("noisy_responses");

const scenarios = {};
const thresholds = {};
for (const shop of quiet) {
  for (const [name, startTime] of [["baseline", "0s"], ["noise", phase]]) {
    scenarios[`${shop}-${name}`] = {
      executor: "constant-arrival-rate",
      rate: 1,
      timeUnit: "1s",
      duration: phase,
      startTime,
      preAllocatedVUs: 4,
      maxVUs: 12,
      exec: "buyer",
      env: { SHOP: shop },
      tags: { shop, phase: name },
    };
    // A threshold per tag set makes k6 report that submetric in its summary.
    thresholds[`checkout_seconds{shop:${shop},phase:${name}}`] = ["p(95)>=0"];
    thresholds[`journey_failures{shop:${shop},phase:${name}}`] = ["count>=0"];
  }
}
scenarios.noisy = {
  executor: "constant-arrival-rate",
  rate: noisyRate,
  timeUnit: "1s",
  duration: phase,
  startTime: phase,
  preAllocatedVUs: 50,
  maxVUs: 200,
  exec: "noise",
  tags: { shop: noisy, phase: "noise" },
};
for (const codeClass of ["2xx", "3xx", "4xx", "429", "5xx", "none"]) thresholds[`noisy_responses{code_class:${codeClass}}`] = ["count>=0"];

export const options = { scenarios, thresholds, summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "max", "count"] };

const form = { "Content-Type": "application/x-www-form-urlencoded" };
/** A request to `shop` through the ingress, addressed by Host as a browser on its domain would be. */
const get = (shop, path) => http.get(`${ingress}${path}`, { headers: { Host: `${shop}.${domain}` } });
const post = (shop, path, body) => http.post(`${ingress}${path}`, body, { headers: { ...form, Host: `${shop}.${domain}` }, redirects: 0 });

/** One guest's Checkout of the shop's first product, with the decline scenario (Stock unchanged). */
export function buyer() {
  const shop = __ENV.SHOP;
  const home = get(shop, "/");
  const product = /name="productId" value="([0-9a-f-]{36})"/.exec(home.body ?? "")?.[1];
  if (home.status !== 200 || !product) return journeyFailures.add(1);
  post(shop, "/cart/items", `productId=${product}&action=add`);
  const checkout = get(shop, "/checkout");
  const key = /name="checkoutKey" value="([^"]+)"/.exec(checkout.body ?? "")?.[1];
  if (!key) return journeyFailures.add(1);
  const placed = post(shop, "/orders", `checkoutKey=${encodeURIComponent(key)}&paymentScenario=decline`);
  if (placed.status !== 303) return journeyFailures.add(1);
  checkoutSeconds.add(placed.timings.duration / 1000);
}

/** The noisy shop: home pages and Cart adds as fast as the rate asks, whatever the answer. */
export function noise() {
  const res = __ITER % 4 === 0 ? post(noisy, "/cart/items", "productId=00000000-0000-4000-8000-000000000000&action=add") : get(noisy, "/");
  const codeClass = res.status === 0 ? "none" : res.status === 429 ? "429" : `${Math.floor(res.status / 100)}xx`;
  noisyResponses.add(1, { code_class: codeClass });
}

export function handleSummary(data) {
  const pick = (name) => data.metrics[name]?.values ?? {};
  const result = { quiet: {}, noisy: {} };
  for (const shop of quiet) {
    result.quiet[shop] = {};
    for (const p of ["baseline", "noise"]) {
      result.quiet[shop][p] = {
        checkoutP95: pick(`checkout_seconds{shop:${shop},phase:${p}}`)["p(95)"] ?? null,
        checkouts: pick(`checkout_seconds{shop:${shop},phase:${p}}`).count ?? 0,
        failures: pick(`journey_failures{shop:${shop},phase:${p}}`).count ?? 0,
      };
    }
  }
  for (const codeClass of ["2xx", "3xx", "4xx", "429", "5xx", "none"]) result.noisy[codeClass] = pick(`noisy_responses{code_class:${codeClass}}`).count ?? 0;
  return { "/out/result.json": JSON.stringify(result, null, 2), stdout: `${JSON.stringify(result, null, 2)}\n` };
}
