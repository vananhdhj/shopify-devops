import Link from "next/link";
import { listProducts } from "@/lib/catalog";
import { formatPrice } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const products = await listProducts();

  return (
    <>
      <h1>Products</h1>
      <ul className="product-grid">
        {products.map((product) => (
          <li key={product.id} className="product-card">
            <Link href={`/products/${product.id}`}>
              <h2>{product.name}</h2>
              <p className="price">{formatPrice(product.priceMinor, product.currency)}</p>
              <p className="stock">{product.stock > 0 ? `${product.stock} in stock` : "Out of stock"}</p>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
