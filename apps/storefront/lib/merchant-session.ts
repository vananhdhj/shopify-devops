import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { MerchantSignInResult } from "@shop/contracts";
import type { TenantContext } from "@shop/tenancy";
import { requiredEnv } from "./env";

/**
 * A Merchant's session: a signed expiry for one shop, kept only in an httpOnly cookie scoped to
 * /admin and never sent cross-site. The signature covers the shop's tenant id and its credential
 * version (from the router's tenant context), so a cookie carried to another shop's address is
 * invalid there, and a credential change at the control plane signs that shop's sessions out
 * within one routing refresh. Nothing is stored server-side, so signing out clears only this
 * browser's copy; rotating SESSION_SECRET signs every session out.
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

function signature(tenant: TenantContext, expiresAt: number): string {
  return createHmac("sha256", requiredEnv("SESSION_SECRET"))
    .update(`merchant:${tenant.id}:${expiresAt}:${tenant.credentialVersion}`)
    .digest("base64url");
}

export function issueSession(tenant: TenantContext, now = Date.now()): string {
  const expiresAt = now + merchantCookie.options.maxAge * 1000;
  return `${expiresAt}.${signature(tenant, expiresAt)}`;
}

/** True when `value` is an unexpired session issued for this shop's current Merchant credential. */
export function isValidSession(tenant: TenantContext, value: string | undefined, now = Date.now()): boolean {
  const [expires, given] = value?.split(".") ?? [];
  const expiresAt = Number(expires);
  if (!given || !Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  return sameBytes(Buffer.from(given), Buffer.from(signature(tenant, expiresAt)));
}

export type SignInCheck = "ok" | "invalid" | "unavailable";

/**
 * Asks the control plane whether a password is this shop's Merchant password; the credential
 * itself never reaches the cell. While the control plane is unreachable, sign-in is unavailable,
 * but sessions already issued keep working: their check needs only the tenant context.
 */
export async function checkMerchantPassword(tenant: TenantContext, password: string): Promise<SignInCheck> {
  let res: Response;
  try {
    res = await fetch(`${requiredEnv("PLATFORM_API_URL")}/internal/merchant-sign-ins`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-platform-token": requiredEnv("PLATFORM_STOREFRONT_TOKEN") },
      body: JSON.stringify({ tenantId: tenant.id, password }),
      signal: AbortSignal.timeout(3_000),
      cache: "no-store",
    });
  } catch {
    return "unavailable";
  }
  if (!res.ok) return "unavailable";
  const result = (await res.json()) as MerchantSignInResult;
  if (!result.ok) return "invalid";
  // A session binds to the version the router stated. If the control plane's is newer, the router
  // has not refreshed yet; a session issued now would be signed out at once, so ask for a retry.
  return result.credentialVersion === tenant.credentialVersion ? "ok" : "unavailable";
}
