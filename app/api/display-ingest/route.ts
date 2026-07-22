import { timingSafeEqual } from "node:crypto";

import { POST as postMetaState } from "../meta-state/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
};

function hasRelayAccess(request: Request) {
  const relayToken = process.env.META_DISPLAY_RELAY_TOKEN?.trim();
  if (!relayToken) return false;

  const expected = Buffer.from(`Bearer ${relayToken}`);
  const received = Buffer.from(request.headers.get("authorization") ?? "");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export async function POST(request: Request) {
  if (!process.env.META_DISPLAY_RELAY_TOKEN?.trim()) {
    return Response.json(
      { error: "The Meta Display relay token is not configured." },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  if (!hasRelayAccess(request)) {
    return Response.json(
      { error: "The Meta Display relay token is invalid." },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  const metaRequest = new Request(new URL("/api/meta-state", request.url), {
    method: "POST",
    headers: {
      Authorization: request.headers.get("authorization") ?? "",
      "Content-Type": "application/json",
      "x-meeting-room-relay-ingest": "1",
    },
    body: await request.text(),
  });

  return postMetaState(metaRequest);
}
