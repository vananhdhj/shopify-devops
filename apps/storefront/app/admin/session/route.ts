import type { NextRequest } from "next/server";
import { isMerchantPassword, issueSession, merchantCookie } from "@/lib/merchant-session";
import { isCrossSitePost } from "@/lib/merchant";
import { tenantFrom } from "@/lib/tenant";
import { forbiddenCrossSite, seeOther } from "@/lib/see-other";

/** Sign-in form target, for this shop's Merchant. The password is never logged or echoed back. */
export async function POST(request: NextRequest) {
  if (isCrossSitePost(request)) return forbiddenCrossSite();
  const tenant = tenantFrom(request.headers);
  const password = String((await request.formData()).get("password") ?? "");
  if (!(await isMerchantPassword(tenant.id, password))) return seeOther("/admin/login?error=invalid");

  const response = seeOther("/admin");
  response.cookies.set(merchantCookie.name, issueSession(tenant.id), merchantCookie.options);
  return response;
}
