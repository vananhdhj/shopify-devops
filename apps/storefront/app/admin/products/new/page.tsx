import Link from "next/link";
import { Usage } from "@/app/admin/usage";
import { Notice } from "@/app/notice";
import { usage } from "@/lib/admin-api";
import { requireMerchant } from "@/lib/merchant";

export const dynamic = "force-dynamic";

export default async function NewProduct({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireMerchant();
  const [{ error }, current] = await Promise.all([searchParams, usage()]);
  return (
    <>
      <h1>Add product</h1>
      <Usage usage={current} />
      <Notice
        code={error}
        messages={{
          invalid: "Check the name, price, and stock.",
          quota: current
            ? `Your plan allows ${current.productLimit} products, and this shop has ${current.products}.`
            : "This shop has as many products as its plan allows.",
        }}
      />
      <form action="/admin/products" method="post" className="stacked-form">
        <label>
          Name
          <input name="name" required maxLength={200} />
        </label>
        <label>
          Description
          <textarea name="description" maxLength={2000} rows={3} />
        </label>
        <label>
          Price in cents
          <input name="priceMinor" type="number" min={0} step={1} required />
        </label>
        <label>
          Starting stock
          <input name="stock" type="number" min={0} step={1} required />
        </label>
        <button type="submit">Add product</button>
      </form>
      <p>
        <Link href="/admin">Back to orders</Link>
      </p>
    </>
  );
}
