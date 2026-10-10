import type { NextRequest } from "next/server";
import { isMerchantPassword, issueSession, merchantCookie } from "@/lib/merchant-session";
import { isCrossSitePost } from "@/lib/merchant";
import { forbiddenCrossSite, seeOther } from "@/lib/see-other";

/** Sign-in form target. The password is never logged or echoed back. */
export async function POST(request: NextRequest) {
  if (isCrossSitePost(request)) return forbiddenCrossSite();
  const password = String((await request.formData()).get("password") ?? "");
  if (!(await isMerchantPassword(password))) return seeOther("/admin/login?error=invalid");

  const response = seeOther("/admin");
  response.cookies.set(merchantCookie.name, issueSession(), merchantCookie.options);
  return response;
}
