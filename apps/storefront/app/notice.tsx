/** Shows the message for a `?error=` code, if the page knows it; unknown codes show nothing. */
export function Notice({ code, messages }: { code: string | undefined; messages: Record<string, string> }) {
  const message = code ? messages[code] : undefined;
  return message ? <p className="notice">{message}</p> : null;
}
