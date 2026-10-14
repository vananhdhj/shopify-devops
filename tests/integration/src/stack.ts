import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { secret } from "./secrets.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** The Makefile's Compose invocation: both cells' files and every secrets file. */
const composeArgs = [
  "compose",
  "-f", "compose.yaml",
  "-f", "compose.dedicated-1.yaml",
  "--env-file", ".secrets/dev.env",
  "--env-file", ".secrets/cells/pool-1.env",
  "--env-file", ".secrets/compose-cells.env",
];

/** Runs `docker compose` against the local stack, the same way the Makefile does. */
export function compose(...args: string[]): string {
  return execFileSync("docker", [...composeArgs, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // A unit's logs over a full suite pass Node's default 1 MB (Phase 7 added the trace ids).
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Stops a container started with `compose run --rm` (addressed by name, not service); --rm removes it. */
export function stopContainer(name: string): void {
  execFileSync("docker", ["stop", "--timeout", "10", name], { stdio: "ignore" });
}

/** (Re)starts one service without touching its dependencies, returning once it is healthy. */
export function restartService(service: string): void {
  compose("up", "--detach", "--no-deps", "--wait", service);
}

export function scaleService(service: string, replicas: number): void {
  compose("up", "--detach", "--no-deps", "--wait", "--scale", `${service}=${replicas}`, service);
}

/** Reads one worker replica's Prometheus metrics from its private operational listener. */
export function workerMetrics(): string {
  return compose("exec", "-T", "worker", "wget", "-qO-", "http://127.0.0.1:4003/metrics");
}

export function metricValue(metrics: string, name: string): number {
  const match = metrics.match(new RegExp(`^${name} ([\\d.e+-]+)$`, "m"));
  if (!match) throw new Error(`metric ${name} not found`);
  return Number(match[1]);
}

/** Runs a Redis command inside the queue's Redis, authenticated with the stack's password. */
export function redisCli(...args: string[]): string {
  return compose("exec", "-T", "redis", "redis-cli", "-a", secret("REDIS_PASSWORD"), "--no-auth-warning", ...args);
}

/** JSON log lines a service wrote in the last two minutes that carry `correlationId` as requestId. */
export function logLinesWith(service: string, correlationId: string): Record<string, unknown>[] {
  return compose("logs", "--no-log-prefix", "--since", "2m", service)
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    })
    .filter((entry) => entry.requestId === correlationId);
}


/** True when the opt-in second cell (`make dev-up CELLS=2`) is running and healthy. */
export function secondCellRunning(): boolean {
  try {
    return compose("ps", "--status", "running", "--format", "{{.Service}} {{.Health}}", "dedicated-1-storefront").includes(
      "dedicated-1-storefront healthy",
    );
  } catch {
    return false;
  }
}
