import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  // Self-contained server bundle for the container image.
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  poweredByHeader: false,
};

export default config;
