import "server-only";
import { createHmac, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { requiredEnv } from "./env";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/**
 * The Merchant's session: a signed expiry, kept only in an httpOnly cookie scoped to /admin and
 * never sent cross-site. Nothing is stored server-side, so signing out clears only this browser's
 * copy; changing the password (its hash is part of the signature) or rotating SESSION_SECRET
 * signs every session out.
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

function signature(expiresAt: number): string {
  return createHmac("sha256", requiredEnv("SESSION_SECRET"))
    .update(`merchant:${expiresAt}:${requiredEnv("ADMIN_PASSWORD_HASH")}`)
    .digest("base64url");
}

export function issueSession(now = Date.now()): string {
  const expiresAt = now + merchantCookie.options.maxAge * 1000;
  return `${expiresAt}.${signature(expiresAt)}`;
}

export function isValidSession(value: string | undefined, now = Date.now()): boolean {
  const [expires, given] = value?.split(".") ?? [];
  const expiresAt = Number(expires);
  if (!given || !Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  return sameBytes(Buffer.from(given), Buffer.from(signature(expiresAt)));
}

/**
 * Checks a password against ADMIN_PASSWORD_HASH (`scrypt:<salt hex>:<key hex>`). Asynchronous,
 * so a burst of sign-in attempts doesn't block the storefront's event loop for shoppers.
 */
export async function isMerchantPassword(password: string): Promise<boolean> {
  const [scheme, salt, key] = requiredEnv("ADMIN_PASSWORD_HASH").split(":");
  if (scheme !== "scrypt" || !salt || !key) throw new Error("ADMIN_PASSWORD_HASH is not an scrypt hash");
  const expected = Buffer.from(key, "hex");
  return sameBytes(await scryptAsync(password, Buffer.from(salt, "hex"), expected.length), expected);
}
