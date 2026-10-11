import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { currentTenant } from "@/lib/tenant";
import "./globals.css";

// Every page belongs to the shop the router named, so nothing is rendered ahead of a request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { name } = await currentTenant();
  return { title: name, description: `${name}, a shop on the DevOps lab platform` };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { name } = await currentTenant();
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="brand">
            {name}
          </Link>
          <Link href="/cart" className="cart-link">
            Cart
          </Link>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
