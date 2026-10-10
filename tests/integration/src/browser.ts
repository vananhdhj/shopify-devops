import { storefrontUrl } from "./http.ts";

/** A minimal browser: remembers the cart cookie and submits forms the way an HTML form does. */
export class Browser {
  private cookie = "";

  async submit(path: string, fields: Record<string, string>): Promise<Response> {
    const res = await fetch(`${storefrontUrl}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: this.cookie },
      body: new URLSearchParams(fields),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0]!;
    return res;
  }

  async get(path: string): Promise<Response> {
    return fetch(`${storefrontUrl}${path}`, { redirect: "manual", headers: { cookie: this.cookie } });
  }

  async html(path: string): Promise<string> {
    return (await fetch(`${storefrontUrl}${path}`, { headers: { cookie: this.cookie } })).text();
  }

  /** Pretends the browser already holds a cookie, e.g. one naming a Cart that no longer exists. */
  useCookie(cookie: string): void {
    this.cookie = cookie;
  }

  get cartCookie(): string {
    return this.cookie;
  }
}
