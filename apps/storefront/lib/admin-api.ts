import "server-only";
import type { AdminOrderList, AdminUsage, NewProduct } from "@shop/contracts";
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

/**
 * True when the product was deleted (Phase 6); false when there is none, or the catalog API is of
 * the previous release, which a storefront can meet while its cell rolls. No body, so no content type.
 */
export async function deleteProduct(productId: string): Promise<boolean> {
  const res = await backendFetch("CATALOG_API_URL", `/admin/products/${encodeURIComponent(productId)}`, {
    method: "DELETE",
    headers: { "x-admin-token": requiredEnv("ADMIN_SERVICE_TOKEN") },
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`delete product failed: ${res.status}`);
  return true;
}

/** Whether the catalog accepted the product, refused the input, or refused it over the plan's quota. */
export async function addProduct(product: NewProduct): Promise<"added" | "invalid" | "quota"> {
  const res = await backendFetch("CATALOG_API_URL", "/admin/products", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify(product),
  });
  if (res.status === 400) return "invalid";
  if (res.status === 409) return "quota";
  if (!res.ok) throw new Error(`add product failed: ${res.status}`);
  return "added";
}

/**
 * The shop's products and plan limits, for its Merchant (Phase 5). Undefined from a catalog API of
 * the previous release, which a storefront can meet while its cell rolls: the page then omits it.
 */
export async function usage(): Promise<AdminUsage | undefined> {
  const res = await backendFetch("CATALOG_API_URL", "/admin/usage", { headers: adminHeaders() });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`usage failed: ${res.status}`);
  return (await res.json()) as AdminUsage;
}
