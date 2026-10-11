import { createHmac, timingSafeEqual } from "node:crypto";

/** One shop on the platform. The id is permanent; the handle is the shop's address label. */
export interface Tenant {
  id: string;
  handle: string;
  name: string;
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
  /** Issued-at, Unix seconds. */
  iat: number;
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** `base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, payload))`. */
export function signTenantContext(tenant: Tenant, secret: string, now = Date.now()): string {
  const body: Payload = { id: tenant.id, handle: tenant.handle, name: tenant.name, iat: Math.floor(now / 1000) };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

/** The tenant a context names, or undefined when it is missing, malformed, tampered with, or expired. */
export function verifyTenantContext(
  value: string | string[] | null | undefined,
  secret: string,
  now = Date.now(),
): Tenant | undefined {
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
  const { id, handle, name, iat } = body;
  if (typeof id !== "string" || typeof handle !== "string" || typeof name !== "string" || typeof iat !== "number") {
    return undefined;
  }
  const age = Math.floor(now / 1000) - iat;
  if (age > maxAgeSeconds || age < -maxSkewSeconds) return undefined;
  return { id, handle, name };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A single DNS label: lower-case letters, digits, and inner hyphens. */
const handlePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Parses the static tenant table (`deploy/base/tenants.json`), failing loudly on anything a
 * router could misroute: a malformed id or handle, a missing name, or a duplicate id or handle.
 */
export function parseTenantTable(json: string): Tenant[] {
  const table = JSON.parse(json) as { tenants?: unknown };
  if (!Array.isArray(table.tenants)) throw new Error("tenant table: `tenants` must be an array");

  const tenants = table.tenants.map((entry: Partial<Tenant>, index) => {
    const { id, handle, name } = entry ?? {};
    if (typeof id !== "string" || !uuidPattern.test(id)) throw new Error(`tenant table: entry ${index} has no valid id`);
    if (typeof handle !== "string" || !handlePattern.test(handle)) {
      throw new Error(`tenant table: entry ${index} has no valid handle`);
    }
    if (typeof name !== "string" || name.length === 0) throw new Error(`tenant table: entry ${index} has no name`);
    return { id, handle, name };
  });

  for (const key of ["id", "handle"] as const) {
    const values = tenants.map((tenant) => tenant[key]);
    const duplicate = values.find((value, index) => values.indexOf(value) !== index);
    if (duplicate) throw new Error(`tenant table: duplicate ${key} ${duplicate}`);
  }
  return tenants;
}
