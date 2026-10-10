import { timingSafeEqual } from "node:crypto";

/** Constant-time comparison of a presented secret (header value, token) with the expected one. */
export function secretsEqual(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
