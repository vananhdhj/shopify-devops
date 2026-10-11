import { randomUUID } from "node:crypto";
import formbody from "@fastify/formbody";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Registry } from "prom-client";
import { Counter } from "prom-client";
import { isUuid, loggingOptions, observeRequests } from "@shop/service-kit";
import { acceptSignup, minimumPasswordLength, type SignupRefusal, type SignupRequest, signupStatus } from "./signup.ts";

export interface PublicAppDeps {
  db: Pool;
  environment: string;
  /** Shops live at `<handle>.<baseDomain>`; the signup pages are at the bare base domain. */
  baseDomain: string;
  registry: Registry;
}

const refusalMessages: Record<SignupRefusal, string> = {
  invalid_handle: "A shop address is 3 to 30 lower-case letters, digits, or inner hyphens.",
  reserved_handle: "That shop address is reserved. Choose another.",
  invalid_name: "A shop name is 1 to 80 characters.",
  weak_password: `Choose a password of at least ${minimumPasswordLength} characters.`,
  invalid_key: "Something went wrong with the form. Reload the page and try again.",
  handle_taken: "That shop address is taken. Choose another.",
  signup_key_reused: "This form was already used for a different shop. Reload the page and try again.",
};

const refusalStatus: Record<SignupRefusal, number> = {
  invalid_handle: 422,
  reserved_handle: 422,
  invalid_name: 422,
  weak_password: 422,
  invalid_key: 422,
  handle_taken: 409,
  signup_key_reused: 409,
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, body: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${head}
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
label{display:block;margin:.8rem 0}input{display:block;width:100%;padding:.4rem;font:inherit}
button{margin-top:1rem;padding:.5rem 1rem;font:inherit}.error{color:#a00}</style></head>
<body>${body}</body></html>`;
}

function signupForm(error?: string, values: Partial<SignupRequest> = {}): string {
  return page(
    "Open a shop",
    `<h1>Open a shop</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/signups">
  <input type="hidden" name="idempotencyKey" value="${randomUUID()}">
  <label>Shop address<input name="handle" required value="${escapeHtml(values.handle ?? "")}" placeholder="e.g. corner-books"></label>
  <label>Shop name<input name="name" required value="${escapeHtml(values.name ?? "")}"></label>
  <label>Merchant password<input type="password" name="password" required minlength="${minimumPasswordLength}" autocomplete="new-password"></label>
  <button type="submit">Open my shop</button>
</form>`,
  );
}

/** The shop's address on the same platform host and port the request came in on. */
function shopUrl(req: FastifyRequest, baseDomain: string, handle: string, path: string): string {
  const port = (req.headers.host ?? "").match(/:(\d+)$/)?.[1];
  return `http://${handle}.${baseDomain}${port ? `:${port}` : ""}${path}`;
}

/** True when a form post names another site as its origin; the storefront refuses those too. */
function isCrossSitePost(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

/**
 * The control plane's public listener: the signup pages, the only part of the control plane the
 * router forwards from the bare platform address. Everything else (the routing table, sign-in
 * checks, operator actions) lives on the internal listener, which is never on the ingress.
 */
export function buildPublicApp(deps: PublicAppDeps) {
  const app = Fastify(loggingOptions("platform-api", deps.environment));
  observeRequests(app, deps.registry);
  app.register(formbody);

  const signups = new Counter({
    name: "platform_signups_total",
    help: "Signup requests by outcome (accepted, or the refusal reason)",
    labelNames: ["outcome"] as const,
    registers: [deps.registry],
  });

  const html = (reply: FastifyReply, status: number, body: string) =>
    reply.code(status).type("text/html; charset=utf-8").send(body);

  app.get("/", async (_req, reply) => html(reply, 200, signupForm()));

  // An HTML form gets pages and redirects; a JSON client gets 202 and a status URL.
  app.post<{ Body: Partial<SignupRequest> }>("/signups", async (req, reply) => {
    const isForm = req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded") ?? false;
    if (isForm && isCrossSitePost(req)) return reply.code(403).send({ error: "cross_site" });

    const body = req.body ?? {};
    const request: SignupRequest = {
      idempotencyKey: String(body.idempotencyKey ?? ""),
      handle: String(body.handle ?? ""),
      name: String(body.name ?? ""),
      password: String(body.password ?? ""),
    };
    const result = await acceptSignup(deps.db, request);
    signups.inc({ outcome: result.outcome === "accepted" ? "accepted" : result.reason });

    if (result.outcome === "refused") {
      req.log.info({ reason: result.reason }, "signup refused");
      if (isForm) return html(reply, refusalStatus[result.reason], signupForm(refusalMessages[result.reason], request));
      return reply.code(refusalStatus[result.reason]).send({ error: result.reason, message: refusalMessages[result.reason] });
    }

    req.log.info({ tenantId: result.tenantId }, "signup accepted");
    const statusUrl = `/signups/${result.tenantId}`;
    if (isForm) return reply.code(303).header("location", statusUrl).send();
    return reply.code(202).header("location", statusUrl).send({ tenantId: result.tenantId, status: "PROVISIONING", statusUrl });
  });

  // Polled while the shop is set up; once it is active, sends the Merchant to their sign-in page.
  app.get<{ Params: { id: string } }>("/signups/:id", async (req, reply) => {
    const status = isUuid(req.params.id) ? await signupStatus(deps.db, req.params.id) : undefined;
    if (!status) return html(reply, 404, page("Not found", "<h1>No such signup</h1>"));

    const signIn = shopUrl(req, deps.baseDomain, status.handle, "/admin/login");
    if (req.headers.accept?.includes("application/json")) return { ...status, signInUrl: signIn };
    if (status.status === "ACTIVE") return reply.code(303).header("location", signIn).send();
    return html(
      reply,
      200,
      page(
        "Setting up your shop",
        `<h1>Setting up ${escapeHtml(status.name)}</h1><p>Your shop will be at <code>${escapeHtml(status.handle)}.${escapeHtml(deps.baseDomain)}</code>. This page moves on by itself in a few seconds.</p>`,
        '<meta http-equiv="refresh" content="1">',
      ),
    );
  });

  return app;
}
