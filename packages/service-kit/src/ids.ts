const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Database ids and Cart tokens are UUIDs; anything else names nothing, so callers can answer 404 early. */
export function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}
