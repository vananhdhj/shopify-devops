import { storefrontUrl } from "./http.ts";

/** A minimal browser: remembers the cart cookie and submits forms the way an HTML form does. */
export class Browser {
  private jar = "";

  async submit(path: string, fields: Record<string, string>, origin?: string): Promise<Response> {
    const res = await fetch(`${storefrontUrl}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: this.jar,
        ...(origin ? { origin } : {}),
      },
      body: new URLSearchParams(fields),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.jar = setCookie.split(";")[0]!;
    return res;
  }

  async get(path: string): Promise<Response> {
    return fetch(`${storefrontUrl}${path}`, { redirect: "manual", headers: { cookie: this.jar } });
  }

  async html(path: string): Promise<string> {
    return (await fetch(`${storefrontUrl}${path}`, { headers: { cookie: this.jar } })).text();
  }

  /** Pretends the browser already holds a cookie, e.g. one naming a Cart that no longer exists. */
  useCookie(cookie: string): void {
    this.jar = cookie;
  }

  /** The one cookie this browser currently holds, as `name=value` (empty when none). */
  get cookie(): string {
    return this.jar;
  }
}
