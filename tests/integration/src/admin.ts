import { catalogApiUrl, orderServiceUrl } from "./http.ts";
import { secret } from "./secrets.ts";

/** The admin service token, as the storefront presents it to the APIs. */
export const adminToken = () => secret("ADMIN_SERVICE_TOKEN");

type Token = string | null;

function headers(token: Token): Record<string, string> {
  return { "content-type": "application/json", ...(token ? { "x-admin-token": token } : {}) };
}

export async function adminListOrders(token: Token = adminToken()) {
  const res = await fetch(`${orderServiceUrl}/admin/orders`, { headers: headers(token) });
  return { status: res.status, body: (await res.json()) as { orders?: { id: string; status: string }[]; error?: string } };
}

export async function adminSetStatus(orderId: string, status: string, token: Token = adminToken()) {
  const res = await fetch(`${orderServiceUrl}/admin/orders/${orderId}/status`, {
    method: "PATCH",
    headers: headers(token),
    body: JSON.stringify({ status }),
  });
  return { status: res.status, body: (await res.json()) as { status?: string; error?: string } };
}

export async function adminAddProduct(product: Record<string, unknown>, token: Token = adminToken()) {
  const res = await fetch(`${catalogApiUrl}/admin/products`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(product),
  });
  return { status: res.status, body: (await res.json()) as { id?: string; name?: string; error?: string } };
}
