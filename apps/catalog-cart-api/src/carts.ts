import type { Cart, CartItem } from "@shop/contracts";
import type { Queryable } from "@shop/service-kit";

// Every shop sells in one currency; a database constraint keeps every Product in it.
const shopCurrency = "USD";

export type Missing = "cart" | "product";

interface CartItemRow {
  product_id: string;
  name: string;
  price_minor: number;
  quantity: number;
}

function toCart(id: string, rows: CartItemRow[]): Cart {
  const items: CartItem[] = rows.map((row) => ({
    productId: row.product_id,
    name: row.name,
    priceMinor: row.price_minor,
    quantity: row.quantity,
    lineTotalMinor: row.price_minor * row.quantity,
  }));
  const subtotalMinor = items.reduce((sum, item) => sum + item.lineTotalMinor, 0);
  return { id, items, subtotalMinor, currency: shopCurrency };
}

export async function createCart(db: Queryable): Promise<Cart> {
  const { rows } = await db.query<{ id: string }>("INSERT INTO catalog.carts DEFAULT VALUES RETURNING id");
  return toCart(rows[0]!.id, []);
}

/** Reads a Cart with each line at its product's current price; undefined if the token is unknown. */
export async function getCart(db: Queryable, id: string): Promise<Cart | undefined> {
  const exists = await db.query("SELECT 1 FROM catalog.carts WHERE id = $1", [id]);
  if (exists.rowCount === 0) return undefined;

  const { rows } = await db.query<CartItemRow>(
    `SELECT ci.product_id, p.name, p.price_minor, ci.quantity
       FROM catalog.cart_items ci
       JOIN catalog.products p ON p.tenant_id = ci.tenant_id AND p.id = ci.product_id
      WHERE ci.cart_id = $1
      ORDER BY p.name`,
    [id],
  );
  return toCart(id, rows);
}

export type SetQuantityResult =
  | { outcome: "updated"; cart: Cart }
  | { outcome: "not_found"; missing: Missing };

/**
 * Sets one line to an absolute quantity (0 removes it). Never touches Stock: holding
 * stock happens only at Checkout, through Inventory effects.
 */
export async function setCartItemQuantity(
  db: Queryable,
  cartId: string,
  productId: string,
  quantity: number,
): Promise<SetQuantityResult> {
  // Touching updated_at doubles as the existence check for the Cart.
  const touched = await db.query("UPDATE catalog.carts SET updated_at = now() WHERE id = $1", [cartId]);
  if (touched.rowCount === 0) return { outcome: "not_found", missing: "cart" };

  const productExists = await db.query("SELECT 1 FROM catalog.products WHERE id = $1", [productId]);
  if (productExists.rowCount === 0) return { outcome: "not_found", missing: "product" };

  if (quantity === 0) {
    await db.query("DELETE FROM catalog.cart_items WHERE cart_id = $1 AND product_id = $2", [cartId, productId]);
  } else {
    await db.query(
      `INSERT INTO catalog.cart_items (cart_id, product_id, quantity) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, cart_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
      [cartId, productId, quantity],
    );
  }
  return { outcome: "updated", cart: (await getCart(db, cartId))! };
}
