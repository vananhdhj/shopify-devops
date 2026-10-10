import { merchantCookie } from "@/lib/merchant-session";
import { seeOther } from "@/lib/see-other";

/** Sign-out form target. */
export function POST() {
  const response = seeOther("/admin/login");
  response.cookies.set(merchantCookie.name, "", { ...merchantCookie.options, maxAge: 0 });
  return response;
}
