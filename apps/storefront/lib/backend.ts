import "server-only";

/**
 * Builds a URL on one of the backend APIs from its base-URL environment variable. Server-side
 * only: the browser never learns these addresses or calls the APIs itself.
 */
export function backendUrl(baseUrlVariable: "CATALOG_API_URL" | "ORDER_SERVICE_URL", path: string): string {
  const base = process.env[baseUrlVariable];
  if (!base) throw new Error(`missing required environment variable ${baseUrlVariable}`);
  return `${base}${path}`;
}
