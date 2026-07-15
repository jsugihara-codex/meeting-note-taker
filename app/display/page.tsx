"use client";

import { useEffect, useState } from "react";

type MetaState = {
  mode: "idle" | "topics" | "actions" | "chat" | "summary";
  title: string;
  content: string;
  isThinking?: boolean;
  updatedAt: number;
  meetingStatus: "idle" | "connecting" | "recording" | "paused" | "stopped";
};

const CHANNEL_NAME = "meeting-room-meta-display";
const STORAGE_KEY = "meeting-room-meta-state-v2";

const fallback: MetaState = {
  mode: "idle",
  title: "Meeting intelligence",
  content: "",
  isThinking: false,
  updatedAt: 0,
  meetingStatus: "idle",
};

export default function MetaDisplay() {
  const [meta, setMeta] = useState<MetaState>(fallback);

  useEffect(() => {
    const applyMeta = (next: MetaState) => {
      setMeta((current) =>
        next.updatedAt >= current.updatedAt ? next : current,
      );
    };

    const syncFromStorage = () => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) applyMeta(JSON.parse(stored) as MetaState);
      } catch {
        // Keep the preview content when storage is restricted.
      }
    };

    const initialSync = window.setTimeout(syncFromStorage, 0);
    const storageSync = window.setInterval(syncFromStorage, 750);

    const channel = "BroadcastChannel" in window
      ? new BroadcastChannel(CHANNEL_NAME)
      : null;
    if (channel) {
      channel.onmessage = (event: MessageEvent<MetaState>) => applyMeta(event.data);
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY && event.newValue) {
        try {
          applyMeta(JSON.parse(event.newValue) as MetaState);
        } catch {
          // The next polling cycle will retry the durable stored state.
        }
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        syncFromStorage();
        announceReady();
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (
        event.data?.type === "meeting-room-meta-refresh" &&
        event.data.refreshId
      ) {
        const refreshId = String(event.data.refreshId);
        const nextUrl = new URL(window.location.href);
        if (nextUrl.searchParams.get("refresh") !== refreshId) {
          nextUrl.searchParams.set("refresh", refreshId);
          nextUrl.searchParams.set("mode", event.data.mode ?? "idle");
          window.location.replace(nextUrl.toString());
        }
        return;
      }
      if (event.data?.type === "meeting-room-meta-state" && event.data.payload) {
        applyMeta(event.data.payload as MetaState);
      }
    };
    const announceReady = () => {
      try {
        window.opener?.postMessage(
          { type: "meeting-room-meta-display-ready" },
          window.location.origin,
        );
      } catch {
        // Broadcast and storage sync remain available without an opener.
      }
    };
    const onFocus = () => {
      syncFromStorage();
      announceReady();
    };
    const readySyncs = [0, 150, 600, 1500].map((delay) =>
      window.setTimeout(announceReady, delay),
    );

    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    window.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(initialSync);
      window.clearInterval(storageSync);
      readySyncs.forEach((timer) => window.clearTimeout(timer));
      channel?.close();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const isLive = meta.meetingStatus === "recording";

  return (
    <main className={`display-shell mode-${meta.mode}`}>
      <header className="display-header">
        <div className="display-brand">
          <span className="brand-mark" aria-hidden="true" />
          Meeting Room
        </div>
        <div className="display-status">
          <span className={isLive ? "live" : ""} />
          {isLive
            ? "Live meeting"
            : meta.meetingStatus === "paused"
              ? "Meeting paused"
              : meta.meetingStatus === "stopped"
                ? "Meeting complete"
                : "Display ready"}
        </div>
      </header>

      <section className="display-content" aria-live="polite">
        <div className="display-kicker">
          <span>{meta.mode === "chat" ? "Answer from the meeting" : "Meeting intelligence"}</span>
          <i />
        </div>
        <h1>{meta.title}</h1>
        <div className="display-rule" />
        {meta.isThinking ? (
          <div className="display-thinking-indicator" role="status" aria-live="polite">
            <span>Thinking</span>
            <span className="thinking-dots" aria-hidden="true">
              <i /><i /><i />
            </span>
          </div>
        ) : meta.mode === "idle" ? (
          <div className="display-empty-state">
            Choose Key Topics, Action Items, or Chat from the recorder.
          </div>
        ) : (
          <div className="display-lines">
            {meta.content.split("\n").filter(Boolean).map((line, index) => {
              const clean = line.replace(/^[-•*]\s*/, "").replace(/\*\*/g, "");
              const isHeading = /^(Outcome|Key decisions|Next steps|Notes):?$/i.test(clean);
              return isHeading ? (
                <h2 key={`${line}-${index}`}>{clean.replace(/:$/, "")}</h2>
              ) : (
                <article key={`${line}-${index}`}>
                  {meta.mode !== "chat" && <span>{String(index + 1).padStart(2, "0")}</span>}
                  <p>{clean}</p>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <footer className="display-footer">
        <p>Updates automatically from the recorder</p>
        <time>
          {meta.updatedAt > 0
            ? `Last updated ${new Date(meta.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            : "Waiting for an action"}
        </time>
      </footer>
    </main>
  );
}
