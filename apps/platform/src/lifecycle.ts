import { request } from "node:http";
import type { Pool } from "pg";
import type { Queryable } from "@shop/service-kit";

export interface LifecycleEvent {
  eventId: string;
  tenantId: string;
  action: "provision" | "delete" | "move";
  attempts: number;
  createdAt: Date;
}

/** How long a claimed event is reserved for one worker; a worker that crashes lets it lapse. */
const leaseSeconds = 30;

/**
 * Claims up to `batch` lifecycle events that are due, leasing each to this worker by moving its
 * `not_before` forward. The claim commits at once, so no transaction stays open while a step
 * calls out (the router check can take seconds); SKIP LOCKED lets several workers claim side by
 * side, and an event whose worker crashed comes due again when its lease lapses.
 */
export async function claimDue(db: Pool, batch = 10): Promise<LifecycleEvent[]> {
  const { rows } = await db.query<{
    event_id: string;
    tenant_id: string;
    action: "provision" | "delete" | "move";
    attempts: number;
    created_at: Date;
  }>(
    `UPDATE platform.lifecycle_outbox AS e
        SET not_before = now() + make_interval(secs => $2), attempts = e.attempts + 1
      WHERE e.event_id IN (
        SELECT event_id FROM platform.lifecycle_outbox
         WHERE completed_at IS NULL AND not_before <= now()
         ORDER BY not_before
         LIMIT $1
           FOR UPDATE SKIP LOCKED)
      RETURNING e.event_id, e.tenant_id, e.action, e.attempts, e.created_at`,
    [batch, leaseSeconds],
  );
  return rows.map((row) => ({
    eventId: row.event_id,
    tenantId: row.tenant_id,
    action: row.action,
    attempts: row.attempts,
    createdAt: row.created_at,
  }));
}

export async function complete(db: Queryable, eventId: string): Promise<void> {
  await db.query("UPDATE platform.lifecycle_outbox SET completed_at = now() WHERE event_id = $1", [eventId]);
}

/** Puts an event back after a failed attempt, due again after an exponential, capped backoff. */
export async function retryLater(db: Queryable, event: LifecycleEvent): Promise<void> {
  const delaySeconds = Math.min(30, 0.5 * 2 ** Math.min(event.attempts - 1, 6));
  await db.query("UPDATE platform.lifecycle_outbox SET not_before = now() + make_interval(secs => $2) WHERE event_id = $1", [
    event.eventId,
    delaySeconds,
  ]);
}

export async function recordEvent(
  db: Queryable,
  tenantId: string,
  step: string,
  detail: Record<string, unknown> = {},
  transition: { from?: string; to?: string } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO platform.tenant_events (tenant_id, from_status, to_status, step, actor, detail)
     VALUES ($1, $2, $3, $4, 'platform-worker', $5)`,
    [tenantId, transition.from ?? null, transition.to ?? null, step, detail],
  );
}

export interface ShopCheck {
  routerUrl: string;
  baseDomain: string;
}

/** The name as the storefront renders it into HTML (React escapes these five characters). */
function asRendered(name: string): string {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };
  return name.replace(/[&<>"']/g, (c) => entities[c]!);
}

/**
 * Asks the edge for the shop's home page, as a buyer's browser would (by Host), and
 * reports whether it answered 200 with the shop's name. `fetch` cannot set Host, so this uses
 * node:http directly.
 */
export function checkShop({ routerUrl, baseDomain }: ShopCheck, handle: string, name: string): Promise<{ ok: boolean; status: number }> {
  const target = new URL(routerUrl);
  return new Promise((resolve) => {
    const req = request(
      {
        host: target.hostname,
        port: Number(target.port || 80),
        path: "/",
        headers: { host: `${handle}.${baseDomain}`, "x-request-id": `platform-check-${handle}` },
        timeout: 5_000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () =>
          resolve({ ok: res.statusCode === 200 && body.includes(asRendered(name)), status: res.statusCode ?? 0 }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("router check timed out")));
    req.on("error", () => resolve({ ok: false, status: 0 }));
    req.end();
  });
}
