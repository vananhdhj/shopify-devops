import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * An Order token is an HMAC of the order id under a server secret. Nothing token-shaped is
 * stored, yet a retried Checkout can hand back the same token, and a read can be verified.
 * Rotating the secret invalidates every outstanding token.
 */
export function orderTokenFor(orderId: string, secret: string): string {
  return createHmac("sha256", secret).update(orderId).digest("base64url");
}

export function isValidOrderToken(orderId: string, token: string, secret: string): boolean {
  const expected = Buffer.from(orderTokenFor(orderId, secret));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
