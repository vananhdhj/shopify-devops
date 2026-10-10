import type { NextRequest } from "next/server";
import { fulfillOrder } from "@/lib/admin-api";
import { isCrossSitePost, isMerchant } from "@/lib/merchant";
import { forbiddenCrossSite, seeOther } from "@/lib/see-other";

/** "Fulfill" form target: Confirmed → Fulfilled. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSitePost(request)) return forbiddenCrossSite();
  if (!isMerchant(request)) return seeOther("/admin/login");
  const { id } = await params;
  return seeOther((await fulfillOrder(id)) ? "/admin?notice=fulfilled" : "/admin?notice=not-fulfillable");
}
