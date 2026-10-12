import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { Plan } from "@shop/contracts";
import { withTransaction } from "@shop/service-kit";
import { place, roleFor } from "./cells.ts";
import { hashPassword } from "./passwords.ts";

export interface SignupRequest {
  /** Client-generated; retries of one signup reuse it and get the same shop back. */
  idempotencyKey: string;
  handle: string;
  name: string;
  password: string;
  plan: Plan;
}

export type SignupRefusal =
  | "invalid_handle"
  | "reserved_handle"
  | "invalid_name"
  | "weak_password"
  | "invalid_key"
  | "invalid_plan"
  | "handle_taken"
  | "signup_key_reused"
  | "no_capacity";

export type SignupResult = { outcome: "accepted"; tenantId: string } | { outcome: "refused"; reason: SignupRefusal };

/** A single DNS label of 3–30 characters: lower-case letters, digits, and inner hyphens. */
const handlePattern = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
/** Addresses the platform keeps for itself, now or later; `synthetic-…` names the cells' synthetic shops. */
const reservedHandles = new Set(["www", "admin", "api", "platform", "shop", "app", "status", "mail", "canary"]);
export const minimumPasswordLength = 12;

/** The request's fields as received, normalised the way they are stored. */
export function normalise(request: SignupRequest): SignupRequest {
  return {
    idempotencyKey: request.idempotencyKey.trim(),
    handle: request.handle.trim().toLowerCase(),
    name: request.name.trim(),
    password: request.password,
    plan: request.plan,
  };
}

const plans: readonly Plan[] = ["starter", "plus"];

function refusalFor(request: SignupRequest): SignupRefusal | undefined {
  if (request.idempotencyKey.length < 8 || request.idempotencyKey.length > 128) return "invalid_key";
  if (!handlePattern.test(request.handle)) return "invalid_handle";
  if (reservedHandles.has(request.handle) || request.handle.startsWith("synthetic-")) return "reserved_handle";
  if (request.name.length === 0 || request.name.length > 80) return "invalid_name";
  if (request.password.length < minimumPasswordLength || request.password.length > 200) return "weak_password";
  if (!plans.includes(request.plan)) return "invalid_plan";
  return undefined;
}

/**
 * Covers the handle, the name, and the plan: a retry that changes any of them is a different
 * signup. The password is left out, so it never needs to be compared; a retry keeps the first one.
 */
function requestHash(request: SignupRequest): string {
  return createHash("sha256").update(`${request.handle}\n${request.name}\n${request.plan}`).digest("hex");
}

async function priorSignup(db: Pool, request: SignupRequest): Promise<SignupResult | undefined> {
  const { rows } = await db.query<{ tenant_id: string; request_hash: string }>(
    "SELECT tenant_id, request_hash FROM platform.signups WHERE idempotency_key = $1",
    [request.idempotencyKey],
  );
  const prior = rows[0];
  if (!prior) return undefined;
  return prior.request_hash === requestHash(request)
    ? { outcome: "accepted", tenantId: prior.tenant_id }
    : { outcome: "refused", reason: "signup_key_reused" };
}

/** Thrown inside the signup transaction to roll it back when no cell has room. */
class NoCapacity extends Error {}

/**
 * Creates a shop in PROVISIONING, placed in a cell by its plan: the tenant, its placement, its
 * signup record, its audit events, and the request to provision it, in one transaction, so a
 * shop never exists without a cell or without the work that makes it usable. When no cell of
 * the plan's role has room, nothing is written and the signup is refused. A retry with the same
 * key and request returns the same shop, whatever the room left; the same key with another
 * request, or a handle someone already has, is refused. Concurrent retries race on the unique
 * handle and key; the loser reads the winner's committed signup.
 */
export async function acceptSignup(db: Pool, received: SignupRequest): Promise<SignupResult> {
  const request = normalise(received);
  const refusal = refusalFor(request);
  if (refusal) return { outcome: "refused", reason: refusal };

  const prior = await priorSignup(db, request);
  if (prior) return prior;

  const passwordHash = await hashPassword(request.password);
  try {
    const tenantId = await withTransaction(db, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO platform.tenants (handle, name, merchant_password_hash, plan) VALUES ($1, $2, $3, $4) RETURNING id",
        [request.handle, request.name, passwordHash, request.plan],
      );
      const id = rows[0]!.id;
      const cell = await place(client, id, roleFor(request.plan, false));
      if (!cell) throw new NoCapacity();
      await client.query(
        "INSERT INTO platform.signups (idempotency_key, request_hash, tenant_id) VALUES ($1, $2, $3)",
        [request.idempotencyKey, requestHash(request), id],
      );
      await client.query(
        `INSERT INTO platform.tenant_events (tenant_id, from_status, to_status, step, actor, detail)
         VALUES ($1, NULL, 'PROVISIONING', 'created', 'signup', $2)`,
        [id, { handle: request.handle, plan: request.plan }],
      );
      await client.query(
        "INSERT INTO platform.tenant_events (tenant_id, step, actor, detail) VALUES ($1, 'placed', 'signup', $2)",
        [id, { cell }],
      );
      await client.query("INSERT INTO platform.lifecycle_outbox (tenant_id, action) VALUES ($1, 'provision')", [id]);
      return id;
    });
    return { outcome: "accepted", tenantId };
  } catch (err) {
    if (err instanceof NoCapacity) return { outcome: "refused", reason: "no_capacity" };
    if ((err as { code?: string }).code !== "23505") throw err;
    // A concurrent signup won: with the same key it is this signup, otherwise the handle is taken.
    return (await priorSignup(db, request)) ?? { outcome: "refused", reason: "handle_taken" };
  }
}

export interface SignupStatus {
  tenantId: string;
  handle: string;
  name: string;
  status: string;
}

export async function signupStatus(db: Pool, tenantId: string): Promise<SignupStatus | undefined> {
  const { rows } = await db.query<{ id: string; handle: string; name: string; status: string }>(
    "SELECT id, handle, name, status FROM platform.tenants WHERE id = $1",
    [tenantId],
  );
  const row = rows[0];
  return row && { tenantId: row.id, handle: row.handle, name: row.name, status: row.status };
}
