import type { NextRequest, NextResponse } from "next/server";
import type { PaymentScenario } from "@shop/contracts";
import { cartCookie } from "@/lib/cart-cookie";
import { submitCheckout } from "@/lib/orders";
import { seeOther } from "@/lib/see-other";

/**
 * Form target for "Complete checkout". On acceptance the Guest buyer lands on the Order page with
 * its Order token, and the Cart cookie is cleared so the next add starts a fresh Cart.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const cartToken = request.cookies.get(cartCookie.name)?.value;
  if (!cartToken) return seeOtherClearingCart("/cart");

  const result = await submitCheckout({
    cartToken,
    checkoutKey: String(form.get("checkoutKey") ?? ""),
    paymentScenario: String(form.get("paymentScenario") ?? "") as PaymentScenario,
  });

  if (result.outcome === "accepted") {
    const { orderId, orderToken } = result.order;
    return seeOtherClearingCart(`/orders/${orderId}?token=${encodeURIComponent(orderToken)}`, { clearCart: true });
  }
  switch (result.reason) {
    case "cart_already_ordered":
      return seeOtherClearingCart("/cart?error=already-ordered", { clearCart: true });
    case "cart_not_found":
    case "cart_empty":
      return seeOtherClearingCart("/cart");
    case "dependency_unavailable":
      return seeOtherClearingCart("/checkout?error=unavailable");
    case "checkout_key_reused":
    case "invalid_request":
      return seeOtherClearingCart("/checkout?error=retry");
    default: {
      const unhandled: never = result.reason;
      throw new Error(`unhandled checkout error ${String(unhandled)}`);
    }
  }
}

function seeOtherClearingCart(location: string, { clearCart = false } = {}): NextResponse {
  const response = seeOther(location);
  if (clearCart) response.cookies.set(cartCookie.name, "", { ...cartCookie.options, maxAge: 0 });
  return response;
}
