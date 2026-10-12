import { createHmac, timingSafeEqual } from "node:crypto";

/** One shop on the platform. The id is permanent; the handle is the shop's address label. */
export interface Tenant {
  id: string;
  handle: string;
  name: string;
}

/**
 * The tenant a request is for, as the router states it: the shop plus its credential version,
 * which changes whenever the shop's Merchant credential changes, so a Merchant session can be bound
 * to it without the cell ever holding the credential. Not a secret.
 */
export interface TenantContext extends Tenant {
  credentialVersion: number;
}

/**
 * The header that carries the current tenant from the router through every unit of the cell.
 * Its value is signed, so a unit trusts it only when the signature verifies; a tenant named by
 * the client in any other way is never believed.
 */
export const tenantContextHeader = "x-tenant-context";

/** How long a signed context stays valid, and how far ahead of this clock it may have been issued. */
const maxAgeSeconds = 60;
const maxSkewSeconds = 5;

interface Payload {
  id: string;
  handle: string;
  name: string;
  /** Credential version. */
  cv: number;
  /** Issued-at, Unix seconds. */
  iat: number;
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** `base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, payload))`. */
export function signTenantContext(tenant: TenantContext, secret: string, now = Date.now()): string {
  const body: Payload = {
    id: tenant.id,
    handle: tenant.handle,
    name: tenant.name,
    cv: tenant.credentialVersion,
    iat: Math.floor(now / 1000),
  };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

/** The tenant a context names, or undefined when it is missing, malformed, tampered with, or expired. */
export function verifyTenantContext(
  value: string | string[] | null | undefined,
  secret: string,
  now = Date.now(),
): TenantContext | undefined {
  if (typeof value !== "string") return undefined;
  const [payload, given, extra] = value.split(".");
  if (!payload || !given || extra !== undefined) return undefined;

  const expected = Buffer.from(signature(payload, secret));
  const presented = Buffer.from(given);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return undefined;

  let body: Partial<Payload>;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<Payload>;
  } catch {
    return undefined;
  }
  const { id, handle, name, cv, iat } = body;
  if (
    typeof id !== "string" ||
    typeof handle !== "string" ||
    typeof name !== "string" ||
    typeof cv !== "number" ||
    typeof iat !== "number"
  ) {
    return undefined;
  }
  const age = Math.floor(now / 1000) - iat;
  if (age > maxAgeSeconds || age < -maxSkewSeconds) return undefined;
  return { id, handle, name, credentialVersion: cv };
}

export { CellCredentials, type CellCredentialKey, cellIdPattern } from "./cell-credentials.ts";
