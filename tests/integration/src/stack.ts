import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Runs `docker compose` against the local stack, the same way the Makefile does. */
export function compose(...args: string[]): string {
  return execFileSync("docker", ["compose", "--env-file", ".secrets/dev.env", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
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

