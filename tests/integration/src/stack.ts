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

