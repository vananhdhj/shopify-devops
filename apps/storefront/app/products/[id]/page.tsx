import { notFound } from "next/navigation";
import { getProduct } from "@/lib/catalog";
import { formatPrice } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = await getProduct(id);
  if (!product) notFound();

  return (
    <article className="product-detail">
      <h1>{product.name}</h1>
      <p>{product.description}</p>
      <p className="price">{formatPrice(product.priceMinor, product.currency)}</p>
      <p className="stock">{product.stock > 0 ? `${product.stock} in stock` : "Out of stock"}</p>
    </article>
  );
}
