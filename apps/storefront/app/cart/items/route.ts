import { NextResponse, type NextRequest } from "next/server";
import { createCart, getCart, setCartItemQuantity } from "@/lib/catalog";
import { cartCookie } from "@/lib/cart-cookie";

/**
 * Form target for add-to-cart and quantity changes. A plain HTML form post works without
 * JavaScript, and the browser never talks to the catalog API itself.
 *   action=add             -> current quantity + 1
 *   action=set&quantity=N  -> N (0 removes the line)
 * "Add" is read-then-set: two simultaneous adds from one Guest buyer can lose an increment.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const productId = String(form.get("productId") ?? "");
  const action = form.get("action");
  if (action !== "add" && action !== "set") {
    return NextResponse.json({ error: "invalid_request", message: "unknown cart action" }, { status: 400 });
  }

  const existingToken = request.cookies.get(cartCookie.name)?.value;
  const existingCart = existingToken ? await getCart(existingToken) : undefined;

  let quantity: number;
  if (action === "add") {
    quantity = (existingCart?.items.find((item) => item.productId === productId)?.quantity ?? 0) + 1;
  } else {
    const requested = String(form.get("quantity") ?? "");
    // A missing or malformed quantity changes nothing, rather than silently becoming 0.
    if (!/^\d+$/.test(requested)) return redirectToCart();
    quantity = Number(requested);
  }

  const cart = existingCart ?? (await createCart());
  const updated = await setCartItemQuantity(cart.id, productId, quantity);
  if (!updated) {
    // Don't hand a brand-new, empty Cart to a buyer whose first add was refused.
    return redirectToCart("not-added", existingCart ? cart.id : undefined);
  }
  return redirectToCart(undefined, cart.id);
}

function redirectToCart(error?: string, cartToken?: string): NextResponse {
  const location = error ? `/cart?error=${error}` : "/cart";
  const response = new NextResponse(null, { status: 303, headers: { location } });
  if (cartToken) response.cookies.set(cartCookie.name, cartToken, cartCookie.options);
  return response;
}
