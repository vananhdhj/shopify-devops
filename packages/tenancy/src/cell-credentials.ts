import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The per-cell secrets a platform-level unit holds, one file each: `<cell>.<key>`. */
export type CellCredentialKey = "platform-cell-token" | "storefront-token" | "tenant-context-secret";

/**
 * A cell id: a DNS label of 1–20 characters, so it can name a namespace and a file, and its
 * synthetic shop's handle (`synthetic-<cell>`) still fits a handle's 30.
 */
export const cellIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/;

/** How long a value read is trusted before the file is read again, so a rotation lands without a restart. */
const maxAgeMs = 30_000;
/** How soon a missing file is looked for again, so an unknown cell cannot make every request read the disk. */
const missRetryMs = 1_000;

/**
 * Each cell's secrets, read from a directory holding one file per cell and key (a mounted Secret in
 * the cluster, `.secrets/mounts/` in Compose). Files are read on demand and cached, and a missing
 * one is looked for again, so a cell added by `make secrets` is picked up with no restart: a
 * mounted Secret's files change in place.
 */
export class CellCredentials {
  readonly #dir: string;
  readonly #cache = new Map<string, { value: string | undefined; readAt: number }>();

  constructor(dir: string) {
    this.#dir = dir;
  }

  get(cell: string, key: CellCredentialKey): string | undefined {
    if (!cellIdPattern.test(cell)) return undefined;
    const name = `${cell}.${key}`;
    const now = Date.now();
    const cached = this.#cache.get(name);
    if (cached && now - cached.readAt < (cached.value === undefined ? missRetryMs : maxAgeMs)) return cached.value;

    let value: string | undefined;
    try {
      value = readFileSync(join(this.#dir, name), "utf8").trim() || undefined;
    } catch {
      value = undefined;
    }
    this.#cache.set(name, { value, readAt: now });
    return value;
  }
}
