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
  updatedAt: Date.now(),
  meetingStatus: "idle",
};

export default function MetaDisplay() {
  const [meta, setMeta] = useState<MetaState>(fallback);

  useEffect(() => {
    const initialSync = window.setTimeout(() => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) setMeta(JSON.parse(stored) as MetaState);
      } catch {
        // Keep the preview content when storage is restricted.
      }
    }, 0);

    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<MetaState>) => setMeta(event.data);

    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY && event.newValue) {
        setMeta(JSON.parse(event.newValue) as MetaState);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearTimeout(initialSync);
      channel.close();
      window.removeEventListener("storage", onStorage);
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
          Last updated {new Date(meta.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </time>
      </footer>
    </main>
  );
}
