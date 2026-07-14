"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

type SessionState = "idle" | "connecting" | "recording" | "paused" | "stopped";
type InsightMode = "topics" | "actions" | "chat" | "summary";

type TranscriptEntry = {
  id: string;
  time: number;
  speaker: string;
  text: string;
  kind: "speech" | "note";
};

type MetaState = {
  mode: InsightMode;
  title: string;
  content: string;
  updatedAt: number;
  meetingStatus: SessionState;
};

const CHANNEL_NAME = "meeting-room-meta-display";
const STORAGE_KEY = "meeting-room-meta-state";

const previewTranscript: TranscriptEntry[] = [
  {
    id: "preview-1",
    time: 12,
    speaker: "Maya",
    text: "The pilot is working. Legal and security review are the only blockers to expanding it to the wider team.",
    kind: "speech",
  },
  {
    id: "preview-2",
    time: 31,
    speaker: "Arun",
    text: "I can own the revised security response and get it back to the customer by Friday.",
    kind: "speech",
  },
  {
    id: "preview-note",
    time: 43,
    speaker: "Note",
    text: "Confirm whether APAC data residency needs a separate answer.",
    kind: "note",
  },
  {
    id: "preview-3",
    time: 54,
    speaker: "Priya",
    text: "Let’s target a decision next Wednesday and measure success through weekly active workflows, not licensed seats.",
    kind: "speech",
  },
];

const initialTopics = [
  "Pilot expansion depends on completing legal and security review",
  "Weekly active workflows will be the primary success measure",
  "The team is targeting a go / no-go decision next Wednesday",
].join("\n");

function formatTime(seconds: number, includeHours = false) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  const clock = `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return includeHours ? `${String(hours).padStart(2, "0")}:${clock}` : clock;
}

function fallbackInsight(
  mode: InsightMode,
  entries: TranscriptEntry[],
  question = "",
) {
  if (!entries.length) {
    return mode === "chat"
      ? "There is no meeting content to search yet. Start recording or add a note first."
      : "Insights will appear here as the meeting develops.";
  }

  if (entries[0]?.id.startsWith("preview")) {
    if (mode === "actions") {
      return [
        "Arun — Send the revised security response — Friday",
        "Unassigned — Confirm APAC data residency requirements — Timing not set",
        "Priya — Prepare the team for a go / no-go decision — Next Wednesday",
      ].join("\n");
    }
    if (mode === "summary") {
      return [
        "Outcome",
        "The pilot is showing enough value to expand, pending legal and security review.",
        "Key decisions",
        "Measure success through weekly active workflows. Target a go / no-go decision next Wednesday.",
        "Next steps",
        "Arun will return the revised security response by Friday. The team still needs to confirm APAC data residency requirements.",
      ].join("\n");
    }
    if (mode === "chat") {
      const lower = question.toLowerCase();
      if (lower.includes("block") || lower.includes("risk")) {
        return "Legal and security review are the remaining blockers. APAC data residency is an open question that may need a separate response.";
      }
      if (lower.includes("owner") || lower.includes("friday")) {
        return "Arun owns the revised security response and plans to send it by Friday.";
      }
      return "The meeting indicates that the pilot is working, with expansion dependent on legal and security review. The target decision is next Wednesday.";
    }
    return initialTopics;
  }

  const speech = entries.filter((entry) => entry.kind === "speech");
  const notes = entries.filter((entry) => entry.kind === "note");

  if (mode === "actions") {
    const actionLike = speech.filter((entry) =>
      /\b(will|can|own|send|follow up|schedule|confirm|prepare|by (monday|tuesday|wednesday|thursday|friday))\b/i.test(
        entry.text,
      ),
    );
    return actionLike.length
      ? actionLike
          .slice(-5)
          .map((entry) => `${entry.speaker} — ${entry.text}`)
          .join("\n")
      : "No explicit action items have been identified yet.";
  }

  if (mode === "summary") {
    return [
      "Outcome",
      speech.slice(-2).map((entry) => entry.text).join(" ") || "No outcome recorded yet.",
      "Notes",
      notes.map((entry) => entry.text).join(" ") || "No additional notes were added.",
    ].join("\n");
  }

  if (mode === "chat") {
    const terms = question
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 3);
    const match = [...entries]
      .reverse()
      .find((entry) => terms.some((term) => entry.text.toLowerCase().includes(term)));
    return match
      ? `${match.speaker} said: “${match.text}”`
      : "I could not find that in the meeting content so far.";
  }

  return speech.length
    ? speech
        .slice(-4)
        .map((entry) => entry.text)
        .join("\n")
    : "Key topics will appear when speech is transcribed.";
}

function modeTitle(mode: InsightMode) {
  return {
    topics: "Key topics",
    actions: "Action items",
    chat: "Meeting answer",
    summary: "Meeting summary",
  }[mode];
}

function InsightText({ content }: { content: string }) {
  return (
    <div className="insight-text">
      {content.split("\n").filter(Boolean).map((line, index) => {
        const clean = line.replace(/^[-•*]\s*/, "").replace(/\*\*/g, "");
        const isHeading = /^(Outcome|Key decisions|Next steps|Notes):?$/i.test(clean);
        return isHeading ? (
          <h4 key={`${line}-${index}`}>{clean.replace(/:$/, "")}</h4>
        ) : (
          <div className="insight-line" key={`${line}-${index}`}>
            <span aria-hidden="true" />
            <p>{clean}</p>
          </div>
        );
      })}
    </div>
  );
}

export function MeetingRecorder() {
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [entries, setEntries] = useState<TranscriptEntry[]>(previewTranscript);
  const [liveDraft, setLiveDraft] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<InsightMode>("topics");
  const [insight, setInsight] = useState(initialTopics);
  const [question, setQuestion] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [connection, setConnection] = useState<"preview" | "live" | "device">(
    "preview",
  );
  const [error, setError] = useState("");

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const startedAtRef = useRef(0);
  const pausedAtRef = useRef(0);
  const pausedDurationRef = useRef(0);
  const elapsedRef = useRef(0);
  const analysisRequestRef = useRef(0);

  useEffect(() => {
    elapsedRef.current = elapsed;
  }, [elapsed]);

  useEffect(() => {
    if (sessionState !== "recording") return;
    const tick = window.setInterval(() => {
      const next = Math.floor(
        (Date.now() - startedAtRef.current - pausedDurationRef.current) / 1000,
      );
      setElapsed(Math.max(0, next));
    }, 250);
    return () => window.clearInterval(tick);
  }, [sessionState]);

  const publishMeta = useCallback(
    (nextMode = mode, nextContent = insight) => {
      const payload: MetaState = {
        mode: nextMode,
        title: modeTitle(nextMode),
        content: nextContent,
        updatedAt: Date.now(),
        meetingStatus: sessionState,
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
        const channel = new BroadcastChannel(CHANNEL_NAME);
        channel.postMessage(payload);
        channel.close();
      } catch {
        // The embedded preview can restrict cross-tab storage.
      }
    },
    [insight, mode, sessionState],
  );

  useEffect(() => {
    publishMeta();
  }, [publishMeta]);

  const transcriptForAnalysis = useCallback((source = entries) => {
    return source
      .map(
        (entry) =>
          `[${formatTime(entry.time)}] ${entry.kind === "note" ? "Meeting note" : entry.speaker}: ${entry.text}`,
      )
      .join("\n");
  }, [entries]);

  const runAnalysis = useCallback(
    async (nextMode: InsightMode, nextQuestion = "", source = entries) => {
      const requestId = ++analysisRequestRef.current;
      const fallback = fallbackInsight(nextMode, source, nextQuestion);
      setMode(nextMode);
      setInsight(fallback);
      setIsThinking(true);
      publishMeta(nextMode, fallback);

      try {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: nextMode,
            question: nextQuestion,
            transcript: transcriptForAnalysis(source),
          }),
        });
        const result = (await response.json()) as { text?: string };
        if (!response.ok || !result.text) throw new Error("fallback");
        if (requestId === analysisRequestRef.current) {
          setInsight(result.text);
          publishMeta(nextMode, result.text);
        }
      } catch {
        // The deterministic local insight remains visible when no API key is configured.
      } finally {
        if (requestId === analysisRequestRef.current) setIsThinking(false);
      }
    },
    [entries, publishMeta, transcriptForAnalysis],
  );

  useEffect(() => {
    if (
      entries[0]?.id.startsWith("preview") ||
      (mode !== "topics" && mode !== "actions")
    ) {
      return;
    }
    const timer = window.setTimeout(() => runAnalysis(mode, "", entries), 1600);
    return () => window.clearTimeout(timer);
  }, [entries, mode, runAnalysis]);

  const handleRealtimeEvent = useCallback((event: MessageEvent<string>) => {
    try {
      const message = JSON.parse(event.data) as {
        type?: string;
        delta?: string;
        transcript?: string;
        error?: { message?: string };
      };
      if (message.type === "conversation.item.input_audio_transcription.delta") {
        setLiveDraft((current) => current + (message.delta ?? ""));
      }
      if (
        message.type === "conversation.item.input_audio_transcription.completed" &&
        message.transcript?.trim()
      ) {
        const text = message.transcript.trim();
        setEntries((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            time: elapsedRef.current,
            speaker: "Speaker",
            text,
            kind: "speech",
          },
        ]);
        setLiveDraft("");
      }
      if (message.type === "error") {
        setError(message.error?.message ?? "Live transcription had a recoverable error.");
      }
    } catch {
      // Ignore non-JSON WebRTC control events.
    }
  }, []);

  const connectRealtime = useCallback(
    async (stream: MediaStream) => {
      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      stream.getAudioTracks().forEach((track) => peer.addTrack(track, stream));

      const channel = peer.createDataChannel("oai-events");
      dataChannelRef.current = channel;
      channel.onmessage = handleRealtimeEvent;
      channel.onopen = () => setConnection("live");

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const response = await fetch("/api/realtime", {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: peer.localDescription?.sdp ?? offer.sdp,
      });

      if (!response.ok) throw new Error("not-configured");
      const answerSdp = await response.text();
      await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
    },
    [handleRealtimeEvent],
  );

  const startRecording = async () => {
    setError("");
    setSessionState("connecting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.start(1000);

      setEntries([]);
      setInsight("Key topics will appear here as the conversation develops.");
      setMode("topics");
      setElapsed(0);
      setConnection("device");
      startedAtRef.current = Date.now();
      pausedDurationRef.current = 0;
      setSessionState("recording");

      connectRealtime(stream).catch(() => {
        setConnection("device");
        setError(
          "Recording on this device. Connect an OpenAI API key to enable live transcription and meeting intelligence.",
        );
      });
    } catch {
      setSessionState("idle");
      setError("Microphone access is needed to start recording.");
    }
  };

  const pauseRecording = () => {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") recorder.pause();
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
    pausedAtRef.current = Date.now();
    setSessionState("paused");
  };

  const resumeRecording = () => {
    const recorder = recorderRef.current;
    if (recorder?.state === "paused") recorder.resume();
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    pausedDurationRef.current += Date.now() - pausedAtRef.current;
    startedAtRef.current =
      Date.now() - elapsedRef.current * 1000 - pausedDurationRef.current;
    setSessionState("recording");
  };

  const stopRecording = () => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    dataChannelRef.current?.close();
    peerRef.current?.close();
    streamRef.current = null;
    recorderRef.current = null;
    dataChannelRef.current = null;
    peerRef.current = null;
    setLiveDraft("");
    setSessionState("stopped");
  };

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      peerRef.current?.close();
    };
  }, []);

  const saveNote = (event: FormEvent) => {
    event.preventDefault();
    const text = note.trim();
    if (!text) return;
    const entry: TranscriptEntry = {
      id: crypto.randomUUID(),
      time: elapsedRef.current,
      speaker: "Note",
      text,
      kind: "note",
    };
    setEntries((current) => [...current, entry]);
    setNote("");
    setNoteOpen(false);

    if (dataChannelRef.current?.readyState === "open") {
      dataChannelRef.current.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `[Meeting note at ${formatTime(entry.time)} — use as context, not spoken transcript] ${text}`,
              },
            ],
          },
        }),
      );
    }
  };

  const askQuestion = (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text) return;
    runAnalysis("chat", text);
  };

  const statusLabel =
    sessionState === "recording"
      ? connection === "live"
        ? "Live transcription"
        : "Recording on device"
      : sessionState === "paused"
        ? "Recording paused"
        : sessionState === "stopped"
          ? "Recording complete"
          : sessionState === "connecting"
            ? "Connecting microphone"
            : "Preview meeting";

  const isActive = sessionState === "recording" || sessionState === "paused";

  return (
    <main className="app-shell">
      <header className="app-header">
        <a className="brand" href="#top" aria-label="Meeting Room home">
          <span className="brand-mark"><i /><i /><i /></span>
          <span>Meeting Room</span>
        </a>
        <div className="header-status">
          <span className={`status-dot ${sessionState}`} />
          {statusLabel}
        </div>
        <a
          className="display-link"
          href="/display"
          target="_blank"
          rel="noopener noreferrer"
        >
          Open Meta Display <span aria-hidden="true">↗</span>
        </a>
      </header>

      <div className="workspace" id="top">
        <section className="meeting-column" aria-label="Meeting recorder">
          <div className="meeting-title-row">
            <div>
              <p className="eyebrow">Live meeting</p>
              <h1>New meeting</h1>
              <p className="meeting-date">
                Today · Private to this device · Notes are added to AI context
              </p>
            </div>
            <div className="participant-stack" aria-label="3 participants in preview">
              <span>M</span><span>A</span><span>P</span><b>3</b>
            </div>
          </div>

          <section className={`recorder-card ${sessionState}`} aria-label="Recording controls">
            <div className="recorder-topline">
              <div className="recording-state">
                <span className="recording-pulse" />
                <span>{statusLabel}</span>
              </div>
              <time>{formatTime(elapsed, true)}</time>
            </div>

            <div className="waveform" aria-hidden="true">
              {Array.from({ length: 41 }, (_, index) => (
                <i
                  key={index}
                  style={{
                    height: `${18 + ((index * 17) % 39)}%`,
                    animationDelay: `${(index % 9) * -0.11}s`,
                  }}
                />
              ))}
            </div>

            <div className="recording-controls">
              {!isActive ? (
                <button
                  className="record-button start"
                  type="button"
                  onClick={startRecording}
                  disabled={sessionState === "connecting"}
                >
                  <span className="mic-symbol" aria-hidden="true" />
                  {sessionState === "connecting"
                    ? "Connecting…"
                    : sessionState === "stopped"
                      ? "Record again"
                      : "Start recording"}
                </button>
              ) : (
                <>
                  <button
                    className="record-button stop"
                    type="button"
                    onClick={stopRecording}
                  >
                    <span className="stop-symbol" aria-hidden="true" />
                    Stop recording
                  </button>
                  <button
                    className="secondary-control"
                    type="button"
                    onClick={sessionState === "paused" ? resumeRecording : pauseRecording}
                  >
                    <span aria-hidden="true">
                      {sessionState === "paused" ? "▶" : "Ⅱ"}
                    </span>
                    {sessionState === "paused" ? "Resume" : "Pause"}
                  </button>
                  <button
                    className="secondary-control"
                    type="button"
                    onClick={() => setNoteOpen((current) => !current)}
                  >
                    <span className="note-symbol" aria-hidden="true">＋</span>
                    Add a note
                  </button>
                </>
              )}
            </div>

            {noteOpen && isActive && (
              <form className="note-composer" onSubmit={saveNote}>
                <div className="note-heading">
                  <div>
                    <b>Add context at {formatTime(elapsed)}</b>
                    <span>This note will be included in the transcript and summary.</span>
                  </div>
                  <button type="button" onClick={() => setNoteOpen(false)} aria-label="Close note">×</button>
                </div>
                <textarea
                  autoFocus
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Add a decision, name, correction, or important context…"
                  rows={3}
                />
                <div className="note-actions">
                  <button type="button" onClick={() => setNoteOpen(false)}>Cancel</button>
                  <button type="submit" disabled={!note.trim()}>Add to meeting</button>
                </div>
              </form>
            )}
          </section>

          {error && <div className="inline-alert"><span>i</span>{error}</div>}

          <section className="transcript-card" aria-labelledby="transcript-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">What was said</p>
                <h2 id="transcript-title">Live transcript</h2>
              </div>
              {entries[0]?.id.startsWith("preview") && <span className="preview-badge">Preview content</span>}
            </div>

            <div className="transcript-list" aria-live="polite">
              {!entries.length && !liveDraft && (
                <div className="empty-state">
                  <span className="empty-rings" />
                  <h3>Listening for the conversation</h3>
                  <p>Speech and timestamped notes will appear here in real time.</p>
                </div>
              )}
              {entries.map((entry) => (
                <article className={`transcript-entry ${entry.kind}`} key={entry.id}>
                  <time>{formatTime(entry.time)}</time>
                  <div className="speaker-avatar">{entry.kind === "note" ? "✦" : entry.speaker.charAt(0)}</div>
                  <div>
                    <h3>{entry.kind === "note" ? "Meeting note" : entry.speaker}</h3>
                    <p>{entry.text}</p>
                  </div>
                </article>
              ))}
              {liveDraft && (
                <article className="transcript-entry draft">
                  <time>{formatTime(elapsed)}</time>
                  <div className="speaker-avatar">S</div>
                  <div><h3>Speaker <span>transcribing</span></h3><p>{liveDraft}</p></div>
                </article>
              )}
            </div>
          </section>
        </section>

        <aside className="insight-panel" aria-label="Meeting intelligence">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Meta Display</p>
              <h2>Meeting intelligence</h2>
            </div>
            <span className="live-chip"><i /> Live</span>
          </div>

          <div className="mode-tabs" role="tablist" aria-label="Display mode">
            <button
              className={mode === "topics" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={mode === "topics"}
              onClick={() => runAnalysis("topics")}
            >
              <span aria-hidden="true">⌁</span> Key Topics
            </button>
            <button
              className={mode === "actions" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={mode === "actions"}
              onClick={() => runAnalysis("actions")}
            >
              <span aria-hidden="true">✓</span> Action Items
            </button>
            <button
              className={mode === "chat" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={mode === "chat"}
              onClick={() => {
                setMode("chat");
                setInsight("Ask a question about anything discussed in the meeting.");
              }}
            >
              <span aria-hidden="true">◇</span> Chat
            </button>
          </div>

          {mode === "chat" && (
            <form className="chat-composer" onSubmit={askQuestion}>
              <label htmlFor="meeting-question">Ask about this meeting</label>
              <div>
                <input
                  id="meeting-question"
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="What is blocking the launch?"
                />
                <button type="submit" disabled={!question.trim() || isThinking} aria-label="Ask question">↑</button>
              </div>
            </form>
          )}

          <div className="meta-preview">
            <div className="meta-preview-header">
              <span>{modeTitle(mode)}</span>
              {isThinking && <i>Updating…</i>}
            </div>
            <InsightText content={insight} />
          </div>

          <p className="panel-note">
            This content is mirrored to Meta Display and refreshes as the conversation continues.
          </p>

          <div className="panel-footer-actions">
            {sessionState === "stopped" && (
              <button className="summary-button" type="button" onClick={() => runAnalysis("summary")}>
                Generate meeting summary
              </button>
            )}
            <a
              className="open-display-button"
              href="/display"
              target="_blank"
              rel="noopener noreferrer"
            >
              Present on Meta Display <span aria-hidden="true">↗</span>
            </a>
          </div>
        </aside>
      </div>
    </main>
  );
}
