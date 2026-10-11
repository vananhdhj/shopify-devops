import { shopFetch, shopHost } from "./router.ts";

/**
 * A minimal browser at one shop's address (Harbor Goods unless told otherwise), through the
 * router: remembers the one cookie it was last given and submits forms the way an HTML form does.
 */
export class Browser {
  private jar = "";

  constructor(readonly handle = "harbor") {}

  /** The shop's origin, as a browser on that address would send it with a form post. */
  get origin(): string {
    return `http://${shopHost(this.handle)}`;
  }

  async submit(path: string, fields: Record<string, string>, origin?: string): Promise<Response> {
    const res = await shopFetch(
      path,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: this.jar,
          ...(origin ? { origin } : {}),
        },
        body: new URLSearchParams(fields).toString(),
      },
      this.handle,
    );
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.jar = setCookie.split(";")[0]!;
    return res;
  }

  async get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return shopFetch(path, { headers: { cookie: this.jar, ...headers } }, this.handle);
  }

  async html(path: string): Promise<string> {
    return (await this.get(path)).text();
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
