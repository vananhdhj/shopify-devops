import { randomUUID } from "node:crypto";
import { LogController, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { traceIds } from "./tracing.ts";

/**
 * Structured JSON logs: every line carries service, environment, and severity, and, inside a
 * trace (Phase 7), its `traceId` and `spanId`; request lines carry the caller's `x-request-id`
 * (or a generated one) as `requestId`.
 * Requests are logged by route template (`/carts/:id`), never the raw URL, so tokens and ids
 * in paths or query strings stay out of logs; handlers log the ids they need explicitly.
 */
export function loggingOptions(service: string, environment: string): FastifyServerOptions {
  return {
    logger: {
      base: { service, environment },
      messageKey: "message",
      // A request's logger has the ids bound already (traceRequests); others take the current span's.
      mixin: (_object, _level, logger) => ("traceId" in logger.bindings() ? {} : traceIds()),
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      formatters: {
        level: (label) => ({ severity: label }),
      },
      serializers: {
        req: (req: FastifyRequest) => ({ method: req.method, route: req.routeOptions.url ?? "unmatched" }),
      },
    },
    requestIdHeader: "x-request-id",
    logController: new LogController({ requestIdLogLabel: "requestId" }),
    genReqId: () => randomUUID(),
  };
}
