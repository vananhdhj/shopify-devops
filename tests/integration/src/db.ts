import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

const secretsFile = fileURLToPath(new URL("../../../.secrets/dev.env", import.meta.url));

function secret(name: string): string {
  const line = readFileSync(secretsFile, "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} missing from .secrets/dev.env (run make secrets)`);
  return line.slice(name.length + 1);
}

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
