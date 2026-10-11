import "server-only";
import { createHmac, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { requiredEnv } from "./env";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/**
 * A Merchant's session: a signed expiry for one shop, kept only in an httpOnly cookie scoped to
 * /admin and never sent cross-site. The signature covers the shop's tenant id, so a cookie
 * carried to another shop's address is invalid there. Nothing is stored server-side, so signing
 * out clears only this browser's copy; changing a shop's password (its hash is part of the
 * signature) signs that shop's sessions out, and rotating SESSION_SECRET signs every session out.
 */
export const merchantCookie = {
  name: "merchant_session",
  options: {
    httpOnly: true,
    sameSite: "strict",
    path: "/admin",
    maxAge: 60 * 60 * 8,
    secure: process.env.COOKIE_SECURE === "true",
  },
} as const;

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Each shop's Merchant password hash (`scrypt:<salt hex>:<key hex>`), from MERCHANT_CREDENTIALS
 * (`<tenant id>=<hash>,...`). Undefined for a shop with no Merchant credential.
 */
function passwordHashOf(tenantId: string): string | undefined {
  for (const entry of requiredEnv("MERCHANT_CREDENTIALS").split(",")) {
    const separator = entry.indexOf("=");
    if (entry.slice(0, separator) === tenantId) return entry.slice(separator + 1);
  }
  return undefined;
}

function signature(tenantId: string, passwordHash: string, expiresAt: number): string {
  return createHmac("sha256", requiredEnv("SESSION_SECRET"))
    .update(`merchant:${tenantId}:${expiresAt}:${passwordHash}`)
    .digest("base64url");
}

export function issueSession(tenantId: string, now = Date.now()): string {
  const passwordHash = passwordHashOf(tenantId);
  if (!passwordHash) throw new Error(`no Merchant credential for tenant ${tenantId}`);
  const expiresAt = now + merchantCookie.options.maxAge * 1000;
  return `${expiresAt}.${signature(tenantId, passwordHash, expiresAt)}`;
}

/** True when `value` is an unexpired session issued for this shop's Merchant. */
export function isValidSession(tenantId: string, value: string | undefined, now = Date.now()): boolean {
  const passwordHash = passwordHashOf(tenantId);
  const [expires, given] = value?.split(".") ?? [];
  const expiresAt = Number(expires);
  if (!passwordHash || !given || !Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  return sameBytes(Buffer.from(given), Buffer.from(signature(tenantId, passwordHash, expiresAt)));
}

/**
 * Checks a password against this shop's Merchant hash. Another shop's password never matches.
 * Asynchronous, so a burst of sign-in attempts doesn't block the storefront's event loop for
 * shoppers.
 */
export async function isMerchantPassword(tenantId: string, password: string): Promise<boolean> {
  const passwordHash = passwordHashOf(tenantId);
  if (!passwordHash) return false;
  const [scheme, salt, key] = passwordHash.split(":");
  if (scheme !== "scrypt" || !salt || !key) throw new Error(`Merchant credential for tenant ${tenantId} is not an scrypt hash`);
  const expected = Buffer.from(key, "hex");
  return sameBytes(await scryptAsync(password, Buffer.from(salt, "hex"), expected.length), expected);
}
