import type { FastifyReply, FastifyRequest } from "fastify";
import { secretsEqual } from "./secrets.ts";

/**
 * A route `preHandler` that answers 401 unless the request carries `expected` in `header`.
 * For service-to-service credentials (admin, internal): the caller is another unit, never a browser.
 */
export function requireSecretHeader(header: string, expected: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!secretsEqual(req.headers[header], expected)) {
      return reply.code(401).send({ error: "unauthorized", message: `${header} required` });
    }
  };
}
