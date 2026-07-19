type SessionState = "idle" | "connecting" | "recording" | "paused" | "stopped";
type DisplayMode = "idle" | "topics" | "actions" | "chat" | "summary";

type MetaState = {
  sequence: number;
  mode: DisplayMode;
  title: string;
  content: string;
  isThinking: boolean;
  updatedAt: number;
  meetingStatus: SessionState;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REDIS_KEY = "meeting-room:meta-state:v2";
const STATE_TTL_SECONDS = 6 * 60 * 60;
const localStore = globalThis as typeof globalThis & {
  meetingRoomMetaState?: MetaState | null;
};
const DISPLAY_MODES: DisplayMode[] = [
  "idle",
  "topics",
  "actions",
  "chat",
  "summary",
];
const SESSION_STATES: SessionState[] = [
  "idle",
  "connecting",
  "recording",
  "paused",
  "stopped",
];

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
};

function redisConfig() {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function redisCommand(command: unknown[]) {
  const config = redisConfig();
  if (!config) return null;
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Shared meeting state is unavailable.");
  const result = (await response.json()) as {
    result?: unknown;
    error?: string;
  };
  if (result.error) throw new Error(result.error);
  return result;
}

function isMetaState(value: unknown): value is MetaState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<MetaState>;
  return (
    Number.isSafeInteger(state.sequence) &&
    Number(state.sequence) >= 0 &&
    DISPLAY_MODES.includes(state.mode as DisplayMode) &&
    typeof state.title === "string" &&
    typeof state.content === "string" &&
    typeof state.isThinking === "boolean" &&
    typeof state.updatedAt === "number" &&
    SESSION_STATES.includes(state.meetingStatus as SessionState)
  );
}

async function readState() {
  const config = redisConfig();
  if (config) {
    const result = await redisCommand(["GET", REDIS_KEY]);
    const stored = result?.result;
    if (typeof stored === "string") {
      const parsed = JSON.parse(stored) as unknown;
      if (isMetaState(parsed)) localStore.meetingRoomMetaState = parsed;
    }
  }
  return localStore.meetingRoomMetaState ?? null;
}

function sharedStorageRequired() {
  return process.env.VERCEL === "1" && !redisConfig();
}

function hasWriteAccess(request: Request) {
  const requestOrigin = new URL(request.url).origin;
  const browserOrigin = request.headers.get("origin");
  if (browserOrigin === requestOrigin) return true;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

export async function GET(request: Request) {
  if (sharedStorageRequired()) {
    return Response.json(
      { error: "Shared Meta Display storage is not configured." },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const afterValue = new URL(request.url).searchParams.get("after") ?? "-1";
    const after = Number(afterValue);
    const state = await readState();
    if (!state || (Number.isFinite(after) && state.sequence <= after)) {
      return new Response(null, { status: 204, headers: NO_STORE_HEADERS });
    }
    return Response.json(
      {
        state,
        shared: Boolean(redisConfig()),
        storage: redisConfig() ? "redis" : "local-memory",
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch {
    return Response.json(
      { error: "Shared meeting state is temporarily unavailable." },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}

export async function POST(request: Request) {
  if (!hasWriteAccess(request)) {
    return Response.json(
      { error: "The Meta Display update must come from this application." },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  if (sharedStorageRequired()) {
    return Response.json(
      { error: "Shared Meta Display storage is not configured." },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const next = (await request.json()) as unknown;
    if (!isMetaState(next) || next.content.length > 50_000) {
      return Response.json({ error: "Invalid meeting state." }, { status: 400 });
    }

    const current = await readState();
    if (current && current.sequence >= next.sequence) {
      return Response.json(
        {
          ok: true,
          accepted: false,
          state: current,
          shared: Boolean(redisConfig()),
          storage: redisConfig() ? "redis" : "local-memory",
        },
        { headers: NO_STORE_HEADERS },
      );
    }

    localStore.meetingRoomMetaState = next;
    const config = redisConfig();
    if (config) {
      await redisCommand([
        "SET",
        REDIS_KEY,
        JSON.stringify(next),
        "EX",
        STATE_TTL_SECONDS,
      ]);
    }
    return Response.json(
      {
        ok: true,
        accepted: true,
        state: next,
        shared: Boolean(config),
        storage: config ? "redis" : "local-memory",
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch {
    return Response.json(
      { error: "Meeting state could not be saved." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
