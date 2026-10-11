import pg from "pg";
import { secret } from "./secrets.ts";

const identities = {
  superuser: ["postgres", "DB_SUPERUSER_PASSWORD"],
  catalog: ["catalog_app", "DB_CATALOG_PASSWORD"],
  orders: ["order_app", "DB_ORDER_PASSWORD"],
} as const;

/** Runs `fn` with a connection as one of the stack's database identities, then closes it. */
export async function asIdentity<T>(identity: keyof typeof identities, fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const [user, passwordKey] = identities[identity];
  const client = new pg.Client({ host: "127.0.0.1", port: 55432, database: "shop", user, password: secret(passwordKey) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Reads end state as the superuser, for assertions only. */
export async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return asIdentity("superuser", async (db) => (await db.query<T>(sql, params)).rows);
}

/** Reads or changes the control plane's registry as its database superuser (its own database). */
export async function platformQuery<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({
    host: "127.0.0.1",
    port: 55433,
    database: "platform",
    user: "postgres",
    password: secret("DB_PLATFORM_SUPERUSER_PASSWORD"),
  });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}
