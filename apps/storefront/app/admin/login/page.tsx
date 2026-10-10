import { Notice } from "@/app/notice";

export const dynamic = "force-dynamic";

export default async function MerchantSignIn({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <>
      <h1>Merchant sign-in</h1>
      <Notice code={error} messages={{ invalid: "That password isn't right." }} />
      <form action="/admin/session" method="post" className="stacked-form">
        <label>
          Password
          <input type="password" name="password" autoComplete="current-password" required />
        </label>
        <button type="submit">Sign in</button>
      </form>
    </>
  );
}
