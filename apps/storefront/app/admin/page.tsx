import Link from "next/link";
import type { OrderStatus } from "@shop/contracts";
import { Usage } from "@/app/admin/usage";
import { Notice } from "@/app/notice";
import { listOrders, usage } from "@/lib/admin-api";
import { requireMerchant } from "@/lib/merchant";
import { formatPrice } from "@/lib/money";

export const dynamic = "force-dynamic";

const statusLabels: Record<OrderStatus, string> = {
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  REJECTED_OUT_OF_STOCK: "Rejected: out of stock",
  REJECTED_PAYMENT: "Rejected: payment",
  FULFILLED: "Fulfilled",
};

const notices = {
  "product-added": "Product added.",
  fulfilled: "Order marked fulfilled.",
  "not-fulfillable": "Only a Confirmed order can be fulfilled.",
};

export default async function MerchantOrders({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  await requireMerchant();
  const [{ notice }, { orders, truncated }, current] = await Promise.all([searchParams, listOrders(), usage()]);

  return (
    <>
      <div className="admin-bar">
        <h1>Orders</h1>
        <Link href="/admin/products/new">Add product</Link>
        <form action="/admin/session/end" method="post">
          <button type="submit">Sign out</button>
        </form>
      </div>
      <Notice code={notice} messages={notices} />
      <Usage usage={current} />
      {truncated ? <p className="hint">Showing Confirmed orders first, then the newest; older orders are not listed.</p> : null}
      <table className="cart">
        <thead>
          <tr>
            <th>Order</th>
            <th>Placed</th>
            <th>Items</th>
            <th>Total</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id}>
              <td className="mono">{order.id}</td>
              <td>{new Date(order.createdAt).toLocaleString("en-US")}</td>
              <td>{order.itemCount}</td>
              <td>{formatPrice(order.subtotalMinor, order.currency)}</td>
              <td>{statusLabels[order.status]}</td>
              <td>
                {order.status === "CONFIRMED" ? (
                  <form action={`/admin/orders/${order.id}/fulfillment`} method="post">
                    <button type="submit">Fulfill</button>
                  </form>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
