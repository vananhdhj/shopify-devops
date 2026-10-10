import { defineConfig } from "vitest/config";

// Tests drive the running Compose stack, so files run one at a time:
// some of them stop and start containers.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
