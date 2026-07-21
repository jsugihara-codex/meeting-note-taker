import { timingSafeEqual } from "node:crypto";

import { POST as postMetaState } from "../meta-state/route";

type LenslineState = {
  sequence: number;
  completed: string[];
  partial: string;
  sourceLabel: string;
  live: boolean;
  processing: boolean;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
};
const MAX_COMPLETED_LINES = 24;
const MAX_LINE_LENGTH = 1_000;
const MAX_SOURCE_LENGTH = 60;
let lastLenslineSequence = 0;

function nextLenslineSequence(now: number) {
  lastLenslineSequence = Math.max(now, lastLenslineSequence + 1);
  return lastLenslineSequence;
}

function hasRelayAccess(request: Request) {
  const relayToken = process.env.META_DISPLAY_RELAY_TOKEN?.trim();
  if (!relayToken) return false;

  const expected = Buffer.from(`Bearer ${relayToken}`);
  const received = Buffer.from(request.headers.get("authorization") ?? "");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function isLenslineState(value: unknown): value is LenslineState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<LenslineState>;
  return (
    Number.isSafeInteger(state.sequence) &&
    Number(state.sequence) >= 0 &&
    Array.isArray(state.completed) &&
    state.completed.every((line) => typeof line === "string") &&
    typeof state.partial === "string" &&
    typeof state.sourceLabel === "string" &&
    typeof state.live === "boolean" &&
    typeof state.processing === "boolean"
  );
}

function sanitizeText(value: string, maxLength: number) {
  return value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
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

  let incoming: unknown;
  try {
    incoming = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid Lensline caption payload." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  if (!isLenslineState(incoming)) {
    return Response.json(
      { error: "Invalid Lensline caption payload." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const completed = incoming.completed
    .slice(-MAX_COMPLETED_LINES)
    .map((line) => sanitizeText(line, MAX_LINE_LENGTH))
    .filter(Boolean);
  const partial = sanitizeText(incoming.partial, MAX_LINE_LENGTH);
  const source = sanitizeText(incoming.sourceLabel, MAX_SOURCE_LENGTH) || "Speech";
  const content = [...completed, partial].filter(Boolean).join("\n");
  const updatedAt = Date.now();

  const metaRequest = new Request(new URL("/api/meta-state", request.url), {
    method: "POST",
    headers: {
      Authorization: request.headers.get("authorization") ?? "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sequence: nextLenslineSequence(updatedAt),
      mode: "chat",
      title: `Live translation · ${source} → English`,
      content,
      isThinking: incoming.processing && !content,
      updatedAt,
      meetingStatus: incoming.live ? "recording" : "stopped",
    }),
  });

  return postMetaState(metaRequest);
}
