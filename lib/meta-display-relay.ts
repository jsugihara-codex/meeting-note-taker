export type MetaDisplayRelayState = {
  sequence: number;
};

export type MetaDisplayRelayConfig = {
  endpoint: URL;
  fallbackEndpoint: URL;
  token: string;
};

type RelayError = Error & {
  status?: number;
  code?: string;
  retryable?: boolean;
};

type RelayOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelaysMs?: number[];
  sleep?: (delay: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
};

export function getMetaDisplayRelayConfig(
  remoteOrigin: string,
  env: NodeJS.ProcessEnv = process.env,
): MetaDisplayRelayConfig | null {
  const token = env.META_DISPLAY_RELAY_TOKEN?.trim();
  if (!remoteOrigin || !token) return null;

  try {
    const origin = new URL(remoteOrigin);
    if (!/^https?:$/.test(origin.protocol)) return null;
    return {
      endpoint: new URL("/api/display-ingest", origin.origin),
      fallbackEndpoint: new URL("/api/meta-state", origin.origin),
      token,
    };
  } catch {
    return null;
  }
}

function relayError(
  message: string,
  details: {
    status?: number;
    code?: string;
    retryable?: boolean;
    cause?: unknown;
  } = {},
) {
  const error = new Error(
    message,
    details.cause ? { cause: details.cause } : undefined,
  ) as RelayError;
  error.status = details.status;
  error.code = details.code;
  error.retryable = details.retryable;
  return error;
}

async function postState(
  endpoint: URL,
  state: MetaDisplayRelayState,
  config: MetaDisplayRelayConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
) {
  return fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(state),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function responseResult(response: Response) {
  try {
    return (await response.clone().json()) as { accepted?: boolean };
  } catch {
    return null;
  }
}

export async function publishMetaDisplayState(
  state: MetaDisplayRelayState,
  config: MetaDisplayRelayConfig,
  fetchImpl: typeof fetch = fetch,
  { timeoutMs = 15_000 }: { timeoutMs?: number } = {},
) {
  let response: Response;
  let result: { accepted?: boolean } | null;
  try {
    response = await postState(
      config.endpoint,
      state,
      config,
      fetchImpl,
      timeoutMs,
    );
    result = await responseResult(response);
    const endpointIsUnavailable =
      response.status === 404 ||
      response.status === 405 ||
      (response.ok && typeof result?.accepted !== "boolean");
    if (endpointIsUnavailable) {
      response = await postState(
        config.fallbackEndpoint,
        state,
        config,
        fetchImpl,
        timeoutMs,
      );
      result = await responseResult(response);
    }
  } catch (cause) {
    const errorCause = cause as { code?: unknown; name?: unknown };
    throw relayError("Hosted Meta Display request failed", {
      code:
        (typeof errorCause?.code === "string" && errorCause.code) ||
        (typeof errorCause?.name === "string" && errorCause.name) ||
        "fetch_failed",
      retryable: true,
      cause,
    });
  }

  if (!response.ok) {
    throw relayError(`Hosted Meta Display returned ${response.status}`, {
      status: response.status,
      code: `http_${response.status}`,
      retryable:
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500,
    });
  }

  if (typeof result?.accepted !== "boolean") {
    throw relayError("Hosted Meta Display returned an invalid response", {
      status: response.status,
      code: "invalid_response",
      retryable: true,
    });
  }

  if (result?.accepted === false) {
    throw relayError("Hosted Meta Display ignored a stale meeting state", {
      status: response.status,
      code: "stale_sequence",
      retryable: false,
    });
  }
  return response;
}

export function createMetaDisplayRelay(
  config: MetaDisplayRelayConfig,
  options: RelayOptions = {},
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retryDelaysMs = options.retryDelaysMs ?? [350, 1_000];
  const sleep =
    options.sleep ??
    ((delay: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, delay);
      }));
  const now = options.now ?? Date.now;
  const log = options.log ?? console.error;
  let pendingState: MetaDisplayRelayState | undefined;
  let active = false;
  let idleWaiters: Array<() => void> = [];

  function finishIdle() {
    if (active || pendingState) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  function report(
    error: RelayError,
    state: MetaDisplayRelayState,
    attempt: number,
    latencyMs: number,
    action: string,
  ) {
    const status = error.status ?? "network";
    const errorCause = error.cause as
      | {
          cause?: { code?: unknown };
          code?: unknown;
          name?: unknown;
        }
      | undefined;
    const cause =
      [
        errorCause?.cause?.code,
        errorCause?.code,
        error.code,
        errorCause?.name,
        error.name,
      ].find((value) => typeof value === "string" && value) ?? "unknown";
    log(
      `Hosted Meta Display relay ${action}: sequence=${state.sequence} attempt=${attempt}/${retryDelaysMs.length + 1} status=${status} cause=${cause} latency_ms=${latencyMs}`,
    );
  }

  async function deliver(state: MetaDisplayRelayState) {
    for (
      let attempt = 1;
      attempt <= retryDelaysMs.length + 1;
      attempt += 1
    ) {
      const startedAt = now();
      try {
        await publishMetaDisplayState(state, config, fetchImpl, { timeoutMs });
        return;
      } catch (issue) {
        const error = issue as RelayError;
        const latencyMs = Math.max(0, now() - startedAt);
        if (pendingState) {
          report(error, state, attempt, latencyMs, "superseded");
          return;
        }
        const retryDelay = retryDelaysMs[attempt - 1];
        if (!error.retryable || retryDelay === undefined) {
          report(error, state, attempt, latencyMs, "failed");
          return;
        }
        report(
          error,
          state,
          attempt,
          latencyMs,
          `retrying_in_ms=${retryDelay}`,
        );
        await sleep(retryDelay);
        if (pendingState) return;
      }
    }
  }

  function start() {
    if (active || !pendingState) return;
    active = true;
    void (async () => {
      while (pendingState) {
        const state = pendingState;
        pendingState = undefined;
        await deliver(state);
      }
    })().finally(() => {
      active = false;
      if (pendingState) start();
      else finishIdle();
    });
  }

  return {
    enqueue(state: MetaDisplayRelayState) {
      pendingState = state;
      start();
    },
    whenIdle() {
      if (!active && !pendingState) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
  };
}
