import { notFound } from "next/navigation";
import type { OrderStatus } from "@shop/contracts";
import { formatPrice } from "@/lib/money";
import { getOrder } from "@/lib/orders";
import { LineSummary } from "@/app/line-summary";

export const dynamic = "force-dynamic";

const statusLabels: Record<OrderStatus, string> = {
  PENDING: "Pending: we're confirming stock and payment",
  CONFIRMED: "Confirmed",
  REJECTED_OUT_OF_STOCK: "Rejected: out of stock",
  REJECTED_PAYMENT: "Rejected: payment declined",
  FULFILLED: "Fulfilled",
};

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const [{ id }, { token }] = await Promise.all([params, searchParams]);
  const order = token ? await getOrder(id, token) : undefined;
  if (!order) notFound();

  return (
    <article>
      <h1>Order</h1>
      <p className="status">Status: {statusLabels[order.status]}</p>
      <p className="hint">Keep this page's link: it is the only way to check this order.</p>
      <LineSummary lines={order.items} currency={order.currency} />
      <p className="subtotal">Total: {formatPrice(order.subtotalMinor, order.currency)}</p>
    </article>
  );
}
