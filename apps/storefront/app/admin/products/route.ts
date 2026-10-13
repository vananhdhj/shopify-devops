import type { NextRequest } from "next/server";
import { addProduct } from "@/lib/admin-api";
import { isCrossSitePost, isMerchant } from "@/lib/merchant";
import { forbiddenCrossSite, seeOther } from "@/lib/see-other";

const wholeNumber = /^\d+$/;

/** "Add product" form target; prices are entered in cents. */
export async function POST(request: NextRequest) {
  if (isCrossSitePost(request)) return forbiddenCrossSite();
  if (!isMerchant(request)) return seeOther("/admin/login");

  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? "").trim();
  const [priceMinor, stock] = [field("priceMinor"), field("stock")];
  if (!wholeNumber.test(priceMinor) || !wholeNumber.test(stock)) return seeOther("/admin/products/new?error=invalid");

  const added = await addProduct({
    name: field("name"),
    description: field("description"),
    priceMinor: Number(priceMinor),
    stock: Number(stock),
  });
  if (added === "added") return seeOther("/admin?notice=product-added");
  return seeOther(`/admin/products/new?error=${added}`);
}
