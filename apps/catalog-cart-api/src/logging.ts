import { randomUUID } from "node:crypto";
import type { FastifyServerOptions } from "fastify";

/**
 * Structured JSON logs: every line carries service, environment, and severity;
 * request lines carry the caller's `x-request-id` (or a generated one) as `requestId`.
 */
export function loggingOptions(service: string, environment: string): FastifyServerOptions {
  return {
    logger: {
      base: { service, environment },
      messageKey: "message",
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      formatters: {
        level: (label) => ({ severity: label }),
      },
    },
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "requestId",
    genReqId: () => randomUUID(),
  };
}
