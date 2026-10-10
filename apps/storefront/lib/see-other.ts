import { NextResponse } from "next/server";

/** 303 to a path: the browser follows a form post with a GET. */
export function seeOther(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location } });
}

export function forbiddenCrossSite(): NextResponse {
  return NextResponse.json({ error: "cross_site", message: "form posted from another site" }, { status: 403 });
}
