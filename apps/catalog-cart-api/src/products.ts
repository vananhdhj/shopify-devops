import type { Pool } from "pg";
import type { Product } from "@shop/contracts";

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

export async function listProducts(db: Pool): Promise<Product[]> {
  const { rows } = await db.query<ProductRow>(
    `SELECT ${columns} FROM catalog.products ORDER BY name`,
  );
  return rows.map(toProduct);
}

export async function findProduct(db: Pool, id: string): Promise<Product | undefined> {
  const { rows } = await db.query<ProductRow>(
    `SELECT ${columns} FROM catalog.products WHERE id = $1`,
    [id],
  );
  return rows[0] && toProduct(rows[0]);
}
