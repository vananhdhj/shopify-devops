// Container health check: the Next.js server is up and answering.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
