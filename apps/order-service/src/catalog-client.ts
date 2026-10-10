import type { Cart } from "@shop/contracts";

export class CatalogUnavailableError extends Error {}

/** Reads a Cart from the catalog-cart API with a bounded wait; undefined if the token is unknown. */
export async function fetchCart(catalogApiUrl: string, cartToken: string): Promise<Cart | undefined> {
  let res: Response;
  try {
    res = await fetch(`${catalogApiUrl}/carts/${encodeURIComponent(cartToken)}`, {
      signal: AbortSignal.timeout(3_000),
    });
  } catch (err) {
    throw new CatalogUnavailableError("catalog-cart API unreachable", { cause: err });
  }
  if (res.status === 404) return undefined;
  if (!res.ok) throw new CatalogUnavailableError(`catalog-cart API answered ${res.status}`);
  return (await res.json()) as Cart;
}
