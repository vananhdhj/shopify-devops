// The Cart token lives in an httpOnly cookie: page scripts can't read it, and the
// browser only ever sends it back to the storefront.
export const cartCookie = {
  name: "cart",
  options: {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    secure: process.env.COOKIE_SECURE === "true",
  },
} as const;
