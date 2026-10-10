import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shop",
  description: "A small shop for a DevOps lab",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="brand">
            Shop
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
