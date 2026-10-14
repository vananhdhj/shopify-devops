import type { NextRequest } from "next/server";
import { deleteProduct } from "@/lib/admin-api";
import { isCrossSitePost, isMerchant } from "@/lib/merchant";
import { forbiddenCrossSite, seeOther } from "@/lib/see-other";

/** "Delete" form target: the product leaves the catalog and every Cart (Phase 6). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSitePost(request)) return forbiddenCrossSite();
  if (!isMerchant(request)) return seeOther("/admin/login");
  const { id } = await params;
  return seeOther((await deleteProduct(id)) ? "/admin?notice=product-deleted" : "/admin?notice=product-not-deleted");
}
