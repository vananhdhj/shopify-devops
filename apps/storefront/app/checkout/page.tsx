import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getCart } from "@/lib/catalog";
import { cartCookie } from "@/lib/cart-cookie";
import { formatPrice } from "@/lib/money";
import { LineSummary } from "@/app/line-summary";
import { Notice } from "@/app/notice";

export const dynamic = "force-dynamic";

const scenarios = [
  { value: "approve", label: "Approve" },
  { value: "decline", label: "Decline" },
  { value: "slow", label: "Slow (approves after a delay)" },
] as const;

const notices = {
  retry: "Something changed while you were checking out. Please try again.",
  unavailable: "The shop is busy right now. Please try again in a moment.",
};

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const token = (await cookies()).get(cartCookie.name)?.value;
  const cart = token ? await getCart(token) : undefined;
  if (!cart || cart.items.length === 0) redirect("/cart");

  return (
    <>
      <h1>Checkout</h1>
      <Notice code={error} messages={notices} />
      <LineSummary lines={cart.items} currency={cart.currency} />
      <p className="subtotal">Subtotal: {formatPrice(cart.subtotalMinor, cart.currency)}</p>

      {/* One Checkout key per rendered form: a double submit or a retry reuses it and lands on the same Order. */}
      <form action="/orders" method="post" className="checkout-form">
        <input type="hidden" name="checkoutKey" value={randomUUID()} />
        <fieldset>
          <legend>Test payment</legend>
          {scenarios.map((scenario) => (
            <label key={scenario.value}>
              <input type="radio" name="paymentScenario" value={scenario.value} defaultChecked={scenario.value === "approve"} />{" "}
              {scenario.label}
            </label>
          ))}
        </fieldset>
        <button type="submit">Complete checkout</button>
      </form>
    </>
  );
}
