"use client";

import { useEffect, useRef, useState } from "react";

type MetaState = {
  sequence: number;
  mode: "idle" | "topics" | "actions" | "chat" | "summary";
  title: string;
  content: string;
  isThinking?: boolean;
  updatedAt: number;
  meetingStatus: "idle" | "connecting" | "recording" | "paused" | "stopped";
};

const fallback: MetaState = {
  sequence: -1,
  mode: "idle",
  title: "Transcript chat",
  content: "",
  isThinking: false,
  updatedAt: 0,
  meetingStatus: "idle",
};

function cleanDisplayLines(content: string) {
  return content
    .split("\n")
    .map((line) => line.replace(/^[-•]\s*/, "").trim())
    .filter(Boolean);
}

function cleanDisplayLine(line: string) {
  return line
    .replace(/^[-•]\s*/, "")
    .replace(/^\*{1,2}/, "")
    .replace(/\*{1,2}$/, "")
    .trim();
}

function compatibleLine(current: string, next: string) {
  return current === next || current.startsWith(next) || next.startsWith(current);
}

function isHeadingLine(line: string) {
  return /^(Key topics|Key decisions|Next steps|Notes):?$/i.test(
    cleanDisplayLine(line),
  );
}

function isTopicHeadline(line: string) {
  return /^\*\*.+\*\*$/.test(line.trim());
}

function isLenslineTranslation(title: string) {
  return /^Live translation\b/i.test(title.trim());
}

export default function MetaDisplay() {
  const [meta, setMeta] = useState<MetaState>(fallback);
  const [now, setNow] = useState(() => Date.now());
  const [relayAvailable, setRelayAvailable] = useState(true);
  const [targetLines, setTargetLines] = useState<string[]>([]);
  const [typedLines, setTypedLines] = useState<string[]>([]);
  const lastSequenceRef = useRef(-1);
  const targetLinesRef = useRef<string[]>([]);
  const typedLinesRef = useRef<string[]>([]);
  const renderedModeRef = useRef<MetaState["mode"]>("idle");
  const typingTimerRef = useRef<number | null>(null);
  const displayContentRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const applyMeta = (next: MetaState) => {
      if (next.sequence <= lastSequenceRef.current) return;
      lastSequenceRef.current = next.sequence;
      setMeta(next);
    };
    let serverSyncInFlight = false;
    let failures = 0;
    const syncFromServer = async () => {
      if (serverSyncInFlight) return;
      serverSyncInFlight = true;
      try {
        const response = await fetch(
          `/api/meta-state?after=${lastSequenceRef.current}`,
          { cache: "no-store" },
        );
        if (response.status === 204) {
          failures = 0;
          setRelayAvailable(true);
          return;
        }
        if (!response.ok) throw new Error("Meta Display relay unavailable");
        const result = (await response.json()) as { state?: MetaState | null };
        if (result.state) applyMeta(result.state);
        failures = 0;
        setRelayAvailable(true);
      } catch {
        failures += 1;
        if (failures > 4) setRelayAvailable(false);
      } finally {
        serverSyncInFlight = false;
      }
    };
    void syncFromServer();
    const serverSync = window.setInterval(() => void syncFromServer(), 300);
    const clock = window.setInterval(() => setNow(Date.now()), 2000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void syncFromServer();
      }
    };
    const onFocus = () => {
      void syncFromServer();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(serverSync);
      window.clearInterval(clock);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (typingTimerRef.current !== null) {
      window.clearInterval(typingTimerRef.current);
      typingTimerRef.current = null;
    }

    const nextLines = meta.isThinking ? [] : cleanDisplayLines(meta.content);
    const modeChanged = renderedModeRef.current !== meta.mode;
    renderedModeRef.current = meta.mode;

    let targets = [...targetLinesRef.current];
    let typed = [...typedLinesRef.current];

    if (!nextLines.length) {
      targets = [];
      typed = [];
    } else if (modeChanged) {
      targets = [...nextLines];
      typed = nextLines.map(() => "");
    } else {
      if (targets.length && !compatibleLine(targets[0], nextLines[0])) {
        const overlapIndex = targets.findIndex((line) =>
          compatibleLine(line, nextLines[0]),
        );
        if (overlapIndex > 0) {
          targets = targets.slice(overlapIndex);
          typed = typed.slice(overlapIndex);
        } else {
          targets = [];
          typed = [];
        }
      }

      nextLines.forEach((next, index) => {
        if (index >= targets.length) {
          targets.push(next);
          typed.push("");
          return;
        }

        const current = targets[index];
        if (next.startsWith(current)) {
          targets[index] = next;
        } else if (current.startsWith(next)) {
          targets[index] = next;
          typed[index] = typed[index].slice(0, next.length);
        } else if (next !== current) {
          targets[index] = next;
          typed[index] = "";
        }
      });
      targets = targets.slice(0, nextLines.length);
      typed = typed.slice(0, nextLines.length);
    }

    targetLinesRef.current = targets;
    typedLinesRef.current = typed;
    setTargetLines([...targets]);

    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      typedLinesRef.current = [...targets];
      setTypedLines([...targets]);
      return;
    }

    setTypedLines([...typed]);
    if (!targets.some((line, index) => typed[index]?.length < line.length)) {
      return;
    }

    typingTimerRef.current = window.setInterval(() => {
      const targetLines = targetLinesRef.current;
      const currentLines = [...typedLinesRef.current];
      const lineIndex = currentLines.findIndex(
        (line, index) => line.length < targetLines[index].length,
      );
      if (lineIndex < 0) {
        if (typingTimerRef.current !== null) {
          window.clearInterval(typingTimerRef.current);
          typingTimerRef.current = null;
        }
        return;
      }

      currentLines[lineIndex] +=
        targetLines[lineIndex][currentLines[lineIndex].length];
      typedLinesRef.current = currentLines;
      setTypedLines(currentLines);
    }, 28);

    return () => {
      if (typingTimerRef.current !== null) {
        window.clearInterval(typingTimerRef.current);
        typingTimerRef.current = null;
      }
    };
  }, [meta.content, meta.isThinking, meta.mode, meta.title]);

  useEffect(() => {
    const panel = displayContentRef.current;
    if (!panel) return;
    const frame = window.requestAnimationFrame(() => {
      panel.scrollTop = panel.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [typedLines, meta.content, meta.title]);

  const recorderIsConnected = relayAvailable && now - meta.updatedAt < 8_000;
  const isLive = meta.meetingStatus === "recording" && recorderIsConnected;
  const lenslineTranslation = isLenslineTranslation(meta.title);
  const visibleLines = lenslineTranslation
    ? cleanDisplayLines(meta.content)
    : typedLines;
  const visibleTargets = lenslineTranslation ? visibleLines : targetLines;

  return (
    <main className={`display-shell mode-${meta.mode}`}>
      <header className="display-header">
        <div className="display-brand">
          <span className="brand-mark" aria-hidden="true" />
          Meeting Room
        </div>
        <div className="display-status">
          <span className={isLive ? "live" : ""} />
          {!relayAvailable
            ? "Reconnecting"
            : isLive
            ? "Live meeting"
            : meta.meetingStatus === "paused" && recorderIsConnected
              ? "Meeting paused"
              : meta.meetingStatus === "stopped" && recorderIsConnected
                ? "Meeting complete"
                : "Display ready"}
        </div>
      </header>

      <section
        ref={displayContentRef}
        className="display-content"
        aria-live="polite"
      >
        <div className="display-kicker">
          <span>
            {lenslineTranslation
              ? meta.title
              : meta.mode === "chat"
                ? "Answer from the meeting"
                : "Meeting intelligence"}
          </span>
          <i />
        </div>
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
            Ask a question in the recorder to show the answer here.
          </div>
        ) : (
          <div className="display-lines">
            {visibleLines.map((line, index) => {
              const target = visibleTargets[index] ?? line;
              const cleanTarget = cleanDisplayLine(target);
              const cleanLine = cleanDisplayLine(line);
              const isHeading = isHeadingLine(target);
              const displaySection =
                visibleTargets
                  .slice(0, index + 1)
                  .reverse()
                  .find(isHeadingLine)
                  ?.replace(/:$/, "")
                  .toLowerCase() ?? "";

              const isKeyTopicHeadline =
                displaySection === "key topics" && isTopicHeadline(target);
              const isKeyTopicSummary =
                displaySection === "key topics" &&
                !isHeading &&
                !isKeyTopicHeadline;

              return isHeading ? (
                <h2
                  key={`${meta.mode}-${index}`}
                  aria-label={cleanTarget.replace(/:$/, "")}
                >
                  {cleanLine.replace(/:$/, "")}
                </h2>
              ) : isKeyTopicHeadline ? (
                <h3
                  className="display-topic-title"
                  key={`${meta.mode}-${index}`}
                  aria-label={cleanTarget}
                >
                  {cleanLine}
                </h3>
              ) : (
                <article
                  className={isKeyTopicSummary ? "display-topic-summary" : undefined}
                  key={`${meta.mode}-${index}`}
                >
                  {meta.mode !== "chat" && !isKeyTopicSummary && (
                    <span>{String(index + 1).padStart(2, "0")}</span>
                  )}
                  <p aria-label={cleanTarget}>{cleanLine}</p>
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
