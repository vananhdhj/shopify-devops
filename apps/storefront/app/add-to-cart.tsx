export function AddToCartForm({ productId }: { productId: string }) {
  return (
    <form action="/cart/items" method="post">
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="action" value="add" />
      <button type="submit">Add to cart</button>
    </form>
  );
}
