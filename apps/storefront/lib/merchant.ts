import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { isValidSession, merchantCookie } from "./merchant-session";
import { currentTenant, tenantFrom } from "./tenant";

/** For admin pages: sends anyone without a valid session for this shop's Merchant to sign-in. */
export async function requireMerchant(): Promise<void> {
  const tenant = await currentTenant();
  if (!isValidSession(tenant.id, (await cookies()).get(merchantCookie.name)?.value)) redirect("/admin/login");
}

/** For admin form handlers, which must check the session themselves before acting. */
export function isMerchant(request: NextRequest): boolean {
  return isValidSession(tenantFrom(request.headers).id, request.cookies.get(merchantCookie.name)?.value);
}

/**
 * True when a form post names another site as its origin. Browsers send Origin on form posts;
 * refusing a mismatch backs up SameSite=Strict, which treats other localhost ports as the same site.
 */
export function isCrossSitePost(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.headers.get("host");
  } catch {
    return true;
  }
}
