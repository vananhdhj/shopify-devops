import type { Cart } from "@shop/contracts";
import { SpanKind, traceHeaders, withSpan } from "@shop/service-kit";
import { tenantContextHeader } from "@shop/tenancy";

export class CatalogUnavailableError extends Error {}

/**
 * Reads a Cart from the catalog-cart API with a bounded wait, as the same tenant: the Checkout's
 * own tenant context is passed on, so a Cart of another shop is simply not found. Undefined if
 * the token is unknown.
 */
export async function fetchCart(catalogApiUrl: string, tenantContext: string, cartToken: string): Promise<Cart | undefined> {
  return withSpan("GET catalog /carts/:id", { kind: SpanKind.CLIENT }, async (span) => {
    let res: Response;
    try {
      res = await fetch(`${catalogApiUrl}/carts/${encodeURIComponent(cartToken)}`, {
        headers: { [tenantContextHeader]: tenantContext, ...traceHeaders() },
        signal: AbortSignal.timeout(3_000),
      });
    } catch (err) {
      throw new CatalogUnavailableError("catalog-cart API unreachable", { cause: err });
    }
    span.setAttribute("http.response.status_code", res.status);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new CatalogUnavailableError(`catalog-cart API answered ${res.status}`);
    return (await res.json()) as Cart;
  });
}
