import type { NewProduct, Product } from "@shop/contracts";
import type { Queryable } from "@shop/service-kit";

interface ProductRow {
  id: string;
  name: string;
  description: string;
  price_minor: number;
  currency: string;
  stock: number;
}

const columns = "id, name, description, price_minor, currency, stock";

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    priceMinor: row.price_minor,
    currency: row.currency,
    stock: row.stock,
  };
}

/** Products in the catalog of the tenant the transaction is scoped to (row-level security). */
export async function countProducts(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM catalog.products");
  return rows[0]!.n;
}

export async function listProducts(db: Queryable): Promise<Product[]> {
  const { rows } = await db.query<ProductRow>(
    `SELECT ${columns} FROM catalog.products ORDER BY name`,
  );
  return rows.map(toProduct);
}

export async function findProduct(db: Queryable, id: string): Promise<Product | undefined> {
  const { rows } = await db.query<ProductRow>(
    `SELECT ${columns} FROM catalog.products WHERE id = $1`,
    [id],
  );
  return rows[0] && toProduct(rows[0]);
}

export async function addProduct(db: Queryable, product: NewProduct): Promise<Product> {
  const { rows } = await db.query<ProductRow>(
    `INSERT INTO catalog.products (name, description, price_minor, stock)
     VALUES ($1, $2, $3, $4) RETURNING ${columns}`,
    [product.name, product.description ?? "", product.priceMinor, product.stock],
  );
  return toProduct(rows[0]!);
}

