import "server-only";
import type { AdminOrderList, NewProduct } from "@shop/contracts";
import { backendFetch } from "./backend";
import { requiredEnv } from "./env";

// The admin service token never leaves the storefront server: browsers only hold a session.
function adminHeaders(): Record<string, string> {
  return { "content-type": "application/json", "x-admin-token": requiredEnv("ADMIN_SERVICE_TOKEN") };
}

export async function listOrders(): Promise<AdminOrderList> {
  const res = await backendFetch("ORDER_SERVICE_URL", "/admin/orders", { headers: adminHeaders() });
  if (!res.ok) throw new Error(`admin order list failed: ${res.status}`);
  return (await res.json()) as AdminOrderList;
}

/** True when the Order was Confirmed and is now Fulfilled; false when that transition isn't allowed. */
export async function fulfillOrder(orderId: string): Promise<boolean> {
  const res = await backendFetch("ORDER_SERVICE_URL", `/admin/orders/${encodeURIComponent(orderId)}/status`, {
    method: "PATCH",
    headers: adminHeaders(),
    body: JSON.stringify({ status: "FULFILLED" }),
  });
  if (res.status === 404 || res.status === 409) return false;
  if (!res.ok) throw new Error(`fulfill failed: ${res.status}`);
  return true;
}

/** True when the catalog accepted the product; false when it refused the input. */
export async function addProduct(product: NewProduct): Promise<boolean> {
  const res = await backendFetch("CATALOG_API_URL", "/admin/products", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify(product),
  });
  if (res.status === 400) return false;
  if (!res.ok) throw new Error(`add product failed: ${res.status}`);
  return true;
}
