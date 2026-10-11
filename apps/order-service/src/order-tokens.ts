import { createHmac } from "node:crypto";
import { secretsEqual } from "@shop/service-kit";

/**
 * An Order token is an HMAC of the tenant id and order id under a server secret. Nothing
 * token-shaped is stored, yet a retried Checkout can hand back the same token, and a read can be
 * verified; binding the tenant makes a token from one shop worthless at every other. Rotating
 * the secret invalidates every outstanding token.
 */
export function orderTokenFor(tenantId: string, orderId: string, secret: string): string {
  return createHmac("sha256", secret).update(`${tenantId}:${orderId}`).digest("base64url");
}

export function isValidOrderToken(tenantId: string, orderId: string, token: string, secret: string): boolean {
  return secretsEqual(token, orderTokenFor(tenantId, orderId, secret));
}
