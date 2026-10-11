import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/** `scrypt:<salt hex>:<key hex>`, the format `make secrets` writes for the seeded shops. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 32);
  return `scrypt:${salt.toString("hex")}:${key.toString("hex")}`;
}

/**
 * Checks a password against a stored hash. Asynchronous, so a burst of sign-in attempts does not
 * block the control plane's event loop for the routers and storefronts it also serves.
 */
export async function isPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, key] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "hex");
  const given = await scryptAsync(password, Buffer.from(salt, "hex"), expected.length);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
