/** Source of the UUID pattern, for JSON schemas that validate ids in request bodies. */
export const uuidPatternSource = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const uuidPattern = new RegExp(uuidPatternSource);

/** Database ids and Cart tokens are UUIDs; anything else names nothing, so callers can answer 404 early. */
export function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}
