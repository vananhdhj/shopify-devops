import { cookies } from "next/headers";
import Link from "next/link";
import { getCart } from "@/lib/catalog";
import { cartCookie } from "@/lib/cart-cookie";
import { formatPrice } from "@/lib/money";
import { Notice } from "@/app/notice";

export const dynamic = "force-dynamic";

const notices = {
  "not-added": "That product couldn't be added to your cart.",
  "already-ordered": "That cart was already ordered, so we started a new one.",
};

export default async function CartPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const notice = <Notice code={error} messages={notices} />;
  const token = (await cookies()).get(cartCookie.name)?.value;
  const cart = token ? await getCart(token) : undefined;

  if (!cart || cart.items.length === 0) {
    return (
      <>
        <h1>Cart</h1>
        {notice}
        <p>Your cart is empty.</p>
        <Link href="/">Browse products</Link>
      </>
    );
  }

  return (
    <>
      <h1>Cart</h1>
      {notice}
      <table className="cart">
        <thead>
          <tr>
            <th>Product</th>
            <th>Price</th>
            <th>Quantity</th>
            <th>Total</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {cart.items.map((item) => (
            <tr key={item.productId}>
              <td>
                <Link href={`/products/${item.productId}`}>{item.name}</Link>
              </td>
              <td>{formatPrice(item.priceMinor, cart.currency)}</td>
              <td>
                <form action="/cart/items" method="post" className="inline-form">
                  <input type="hidden" name="productId" value={item.productId} />
                  <input type="hidden" name="action" value="set" />
                  <input type="number" name="quantity" min={0} max={99} defaultValue={item.quantity} aria-label={`Quantity of ${item.name}`} />
                  <button type="submit">Update</button>
                </form>
              </td>
              <td>{formatPrice(item.lineTotalMinor, cart.currency)}</td>
              <td>
                <form action="/cart/items" method="post">
                  <input type="hidden" name="productId" value={item.productId} />
                  <input type="hidden" name="action" value="set" />
                  <input type="hidden" name="quantity" value="0" />
                  <button type="submit">Remove</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="subtotal">Subtotal: {formatPrice(cart.subtotalMinor, cart.currency)}</p>
      <p className="checkout-link">
        <Link href="/checkout">Checkout</Link>
      </p>
    </>
  );
}
