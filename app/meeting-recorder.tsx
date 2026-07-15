"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type SessionState = "idle" | "connecting" | "recording" | "paused" | "stopped";
type InsightMode = "topics" | "actions" | "chat" | "summary";
type DisplayMode = InsightMode | "idle";

type TranscriptEntry = {
  id: string;
  time: number;
  speaker: string;
  text: string;
  kind: "speech" | "note";
  draft?: boolean;
};

type MetaState = {
  mode: DisplayMode;
  title: string;
  content: string;
  isThinking: boolean;
  updatedAt: number;
  meetingStatus: SessionState;
};

const CHANNEL_NAME = "meeting-room-meta-display";
const STORAGE_KEY = "meeting-room-meta-state-v2";
const META_DISPLAY_WINDOW_NAME = "meeting-room-meta-display";
const PARAGRAPH_BREAK_MS = 800;
const SERVER_VAD_SILENCE_MS = 250;
const META_DISPLAY_SYNC_DELAYS_MS = [0, 150, 600, 1500];
const TRANSCRIPTION_PROMPT_LEAKS = [
  "context transcribe a business meeting accurately preserve names acronyms commitments dates and decisions",
  "transcribe a business meeting accurately preserve names acronyms commitments dates and decisions",
];

function isTranscriptionPromptLeak(value: string) {
  const normalized = value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (normalized.length < 4) return false;
  return TRANSCRIPTION_PROMPT_LEAKS.some(
    (prompt) =>
      prompt.startsWith(normalized) ||
      normalized.startsWith(prompt) ||
      (normalized.includes("transcribe a business meeting accurately") &&
        normalized.includes("preserve names acronyms commitments dates and decisions")),
  );
}

function appendTranscriptChunk(current: string, incoming: string) {
  const base = current.replace(/\s+/g, " ").trim();
  const next = incoming.replace(/\s+/g, " ").trim();
  if (!base) return next;
  if (!next) return base;

  const normalizedBase = base.toLocaleLowerCase();
  const normalizedNext = next.toLocaleLowerCase();
  if (
    normalizedBase === normalizedNext ||
    normalizedBase.endsWith(normalizedNext)
  ) {
    return base;
  }
  if (normalizedNext.startsWith(normalizedBase)) return next;

  const baseWords = base.split(" ");
  const nextWords = next.split(" ");
  const normalizeWord = (word: string) =>
    word.toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  const maxOverlap = Math.min(baseWords.length, nextWords.length, 24);
  for (let size = maxOverlap; size > 0; size -= 1) {
    const baseSuffix = baseWords.slice(-size).map(normalizeWord).join(" ");
    const nextPrefix = nextWords.slice(0, size).map(normalizeWord).join(" ");
    if (baseSuffix && baseSuffix === nextPrefix) {
      return [...baseWords, ...nextWords.slice(size)].join(" ");
    }
  }
  return `${base} ${next}`;
}

function mergeTranscriptChunks(chunks: string[]) {
  return chunks.reduce(appendTranscriptChunk, "");
}

function formatTime(seconds: number, includeHours = false) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  const clock = `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return includeHours ? `${String(hours).padStart(2, "0")}:${clock}` : clock;
}

function modeTitle(mode: InsightMode | null) {
  if (!mode) return "Select an action";
  return {
    topics: "Key topics",
    actions: "Action items",
    chat: "Meeting answer",
    summary: "Meeting summary",
  }[mode];
}

function TypewriterText({ text, startDelay = 0 }: { text: string; startDelay?: number }) {
  const [visibleText, setVisibleText] = useState("");
  const [isReady, setIsReady] = useState(startDelay === 0);

  useEffect(() => {
    if (startDelay === 0) return;
    const timer = window.setTimeout(() => setIsReady(true), startDelay);
    return () => window.clearTimeout(timer);
  }, [startDelay]);

  useEffect(() => {
    if (!isReady) return;
    let nextText: string;
    let delay = 14;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      nextText = text;
      delay = 0;
    } else if (!text.startsWith(visibleText)) {
      nextText = text;
      delay = 0;
    } else {
      if (visibleText.length >= text.length) return;
      const remaining = text.length - visibleText.length;
      const charactersPerTick =
        remaining > 160 ? 12 : remaining > 80 ? 8 : remaining > 32 ? 4 : remaining > 12 ? 2 : 1;
      nextText = text.slice(0, visibleText.length + charactersPerTick);
      delay = remaining > 32 ? 8 : remaining > 12 ? 10 : 14;
    }
    const timer = window.setTimeout(
      () => setVisibleText(nextText),
      delay,
    );
    return () => window.clearTimeout(timer);
  }, [isReady, text, visibleText]);

  const isTyping = isReady && visibleText.length < text.length;
  return (
    <span className="typewriter-text" aria-label={text}>
      <span aria-hidden="true">{visibleText}</span>
      {isTyping && <span className="typewriter-cursor" aria-hidden="true" />}
    </span>
  );
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

function ThinkingIndicator() {
  return (
    <div className="thinking-indicator" role="status" aria-live="polite">
      <span>Thinking</span>
      <span className="thinking-dots" aria-hidden="true">
        <i /><i /><i />
      </span>
    </div>
  );
}

export function MeetingRecorder() {
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<InsightMode | null>(null);
  const [insight, setInsight] = useState("");
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
  const metaChannelRef = useRef<BroadcastChannel | null>(null);
  const metaDisplayWindowRef = useRef<Window | null>(null);
  const latestMetaRef = useRef<MetaState | null>(null);
  const latestMetaUpdatedAtRef = useRef(0);
  const metaSyncTimeoutsRef = useRef<number[]>([]);
  const startedAtRef = useRef(0);
  const pausedAtRef = useRef(0);
  const pausedDurationRef = useRef(0);
  const elapsedRef = useRef(0);
  const sessionStateRef = useRef<SessionState>(sessionState);
  const observedEntriesRef = useRef(entries);
  const analysisRequestRef = useRef(0);
  const transcriptListRef = useRef<HTMLDivElement | null>(null);
  const transcriptAutoScrollRef = useRef(true);
  const processedTranscriptionEventsRef = useRef(new Set<string>());
  const lastSpeechEndMsRef = useRef<number | null>(null);
  const activeParagraphIdRef = useRef<string | null>(null);
  const transcriptionItemParagraphRef = useRef(new Map<string, string>());
  const transcriptionItemTextRef = useRef(new Map<string, string>());
  const completedTranscriptionItemsRef = useRef(new Set<string>());
  const paragraphItemIdsRef = useRef(new Map<string, string[]>());
  const paragraphStartedAtRef = useRef(new Map<string, number>());

  useEffect(() => {
    elapsedRef.current = elapsed;
  }, [elapsed]);

  useEffect(() => {
    sessionStateRef.current = sessionState;
  }, [sessionState]);

  useEffect(() => {
    if (!("BroadcastChannel" in window)) return;
    const channel = new BroadcastChannel(CHANNEL_NAME);
    metaChannelRef.current = channel;
    return () => {
      channel.close();
      metaChannelRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.data?.type !== "meeting-room-meta-display-ready" ||
        !event.source
      ) {
        return;
      }
      metaDisplayWindowRef.current = event.source as Window;
      const latest = latestMetaRef.current;
      if (latest) {
        metaDisplayWindowRef.current.postMessage(
          { type: "meeting-room-meta-state", payload: latest },
          window.location.origin,
        );
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    return () => {
      metaSyncTimeoutsRef.current.forEach((timer) => window.clearTimeout(timer));
      metaSyncTimeoutsRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!transcriptAutoScrollRef.current) return;
    const panel = transcriptListRef.current;
    if (!panel) return;
    const frame = window.requestAnimationFrame(() => {
      panel.scrollTop = panel.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [entries]);

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
    (
      nextMode: InsightMode | null,
      nextContent: string,
      nextIsThinking: boolean,
    ) => {
      const payload: MetaState = {
        mode: nextMode ?? "idle",
        title: modeTitle(nextMode),
        content: nextContent,
        isThinking: nextIsThinking,
        updatedAt: Math.max(Date.now(), latestMetaUpdatedAtRef.current + 1),
        meetingStatus: sessionStateRef.current,
      };
      latestMetaUpdatedAtRef.current = payload.updatedAt;
      latestMetaRef.current = payload;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // The embedded preview can restrict cross-tab storage.
      }
      try {
        metaChannelRef.current?.postMessage(payload);
      } catch {
        // Storage polling keeps an open display synchronized as a fallback.
      }
      try {
        metaDisplayWindowRef.current?.postMessage(
          { type: "meeting-room-meta-state", payload },
          window.location.origin,
        );
      } catch {
        metaDisplayWindowRef.current = null;
      }
    },
    [],
  );

  const scheduleMetaDisplaySync = useCallback((displayWindow: Window) => {
    metaDisplayWindowRef.current = displayWindow;
    metaSyncTimeoutsRef.current.forEach((timer) => window.clearTimeout(timer));
    metaSyncTimeoutsRef.current = META_DISPLAY_SYNC_DELAYS_MS.map((delay) =>
      window.setTimeout(() => {
        const latest = latestMetaRef.current;
        const target = metaDisplayWindowRef.current;
        if (!latest || !target || target.closed) return;
        try {
          target.postMessage(
            { type: "meeting-room-meta-state", payload: latest },
            window.location.origin,
          );
        } catch {
          metaDisplayWindowRef.current = null;
        }
      }, delay),
    );
  }, []);

  const refreshMetaDisplay = useCallback(
    (nextMode: InsightMode | null) => {
      const refreshId = Date.now();
      const currentDisplay = metaDisplayWindowRef.current;
      if (currentDisplay && !currentDisplay.closed) {
        try {
          currentDisplay.postMessage(
            {
              type: "meeting-room-meta-refresh",
              refreshId,
              mode: nextMode ?? "idle",
            },
            window.location.origin,
          );
        } catch {
          metaDisplayWindowRef.current = null;
        }
      }

      const displayUrl = new URL("/display", window.location.href);
      displayUrl.searchParams.set("refresh", String(refreshId));
      displayUrl.searchParams.set("mode", nextMode ?? "idle");
      const displayWindow = window.open(
        displayUrl.toString(),
        META_DISPLAY_WINDOW_NAME,
      );
      if (displayWindow) scheduleMetaDisplaySync(displayWindow);
    },
    [scheduleMetaDisplaySync],
  );

  useEffect(() => {
    publishMeta(mode, insight, isThinking);
  }, [insight, isThinking, mode, publishMeta, sessionState]);

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
      setMode(nextMode);
      setInsight("");
      setIsThinking(true);
      publishMeta(nextMode, "", true);

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
          setIsThinking(false);
          publishMeta(nextMode, result.text, false);
        }
      } catch {
        if (requestId === analysisRequestRef.current) {
          const message =
            nextMode === "chat"
              ? "An answer could not be generated. Please try again."
              : `${modeTitle(nextMode)} could not be generated. Please try again.`;
          setInsight(message);
          setIsThinking(false);
          publishMeta(nextMode, message, false);
        }
      } finally {
        if (requestId === analysisRequestRef.current) setIsThinking(false);
      }
    },
    [entries, publishMeta, transcriptForAnalysis],
  );

  useEffect(() => {
    const entriesChanged = observedEntriesRef.current !== entries;
    observedEntriesRef.current = entries;
    if (
      !entriesChanged ||
      mode === null ||
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
        event_id?: string;
        item_id?: string;
        audio_start_ms?: number;
        audio_end_ms?: number;
        delta?: string;
        transcript?: string;
        error?: { message?: string };
      };

      if (
        message.event_id &&
        processedTranscriptionEventsRef.current.has(message.event_id)
      ) {
        return;
      }
      if (message.event_id) {
        processedTranscriptionEventsRef.current.add(message.event_id);
      }

      const createParagraph = () => {
        const paragraphId = crypto.randomUUID();
        activeParagraphIdRef.current = paragraphId;
        paragraphStartedAtRef.current.set(paragraphId, elapsedRef.current);
        paragraphItemIdsRef.current.set(paragraphId, []);
        return paragraphId;
      };
      const activeParagraph = () =>
        activeParagraphIdRef.current ?? createParagraph();
      const registerItem = (itemId: string, paragraphId = activeParagraph()) => {
        transcriptionItemParagraphRef.current.set(itemId, paragraphId);
        const itemIds = paragraphItemIdsRef.current.get(paragraphId) ?? [];
        if (!itemIds.includes(itemId)) {
          paragraphItemIdsRef.current.set(paragraphId, [...itemIds, itemId]);
        }
        return paragraphId;
      };
      const updateParagraph = (paragraphId: string) => {
        const itemIds = paragraphItemIdsRef.current.get(paragraphId) ?? [];
        const text = mergeTranscriptChunks(
          itemIds.map((itemId) => {
            const itemText = transcriptionItemTextRef.current.get(itemId) ?? "";
            return isTranscriptionPromptLeak(itemText) ? "" : itemText;
          }),
        );
        const entryId = `paragraph-${paragraphId}`;
        if (!text) {
          setEntries((current) =>
            current.some((entry) => entry.id === entryId)
              ? current.filter((entry) => entry.id !== entryId)
              : current,
          );
          return;
        }
        const startedAt = paragraphStartedAtRef.current.get(paragraphId) ?? elapsedRef.current;
        const draft = itemIds.some(
          (itemId) => !completedTranscriptionItemsRef.current.has(itemId),
        );
        setEntries((current) => {
          const existingIndex = current.findIndex((entry) => entry.id === entryId);
          if (existingIndex === -1) {
            return [
              ...current,
              {
                id: entryId,
                time: startedAt,
                speaker: "Transcript",
                text,
                kind: "speech",
                draft,
              },
            ];
          }
          if (
            current[existingIndex].text === text &&
            current[existingIndex].draft === draft
          ) {
            return current;
          }
          const next = [...current];
          next[existingIndex] = { ...next[existingIndex], text, draft };
          return next;
        });
      };

      if (message.type === "input_audio_buffer.speech_started") {
        const audioStartMs = message.audio_start_ms ?? elapsedRef.current * 1000;
        const gapMs = lastSpeechEndMsRef.current === null
          ? 0
          : audioStartMs - lastSpeechEndMsRef.current;
        if (!activeParagraphIdRef.current || gapMs > PARAGRAPH_BREAK_MS) {
          createParagraph();
        }
        if (message.item_id) registerItem(message.item_id);
        return;
      }

      if (message.type === "input_audio_buffer.speech_stopped") {
        if (message.item_id) registerItem(message.item_id);
        const audioEndMs = message.audio_end_ms ?? elapsedRef.current * 1000;
        lastSpeechEndMsRef.current = Math.max(
          0,
          audioEndMs - SERVER_VAD_SILENCE_MS,
        );
        return;
      }

      if (message.type === "input_audio_buffer.committed" && message.item_id) {
        registerItem(message.item_id);
        return;
      }

      if (
        message.type === "conversation.item.input_audio_transcription.delta" &&
        message.item_id &&
        message.delta
      ) {
        const paragraphId =
          transcriptionItemParagraphRef.current.get(message.item_id) ??
          registerItem(message.item_id);
        const nextText =
          (transcriptionItemTextRef.current.get(message.item_id) ?? "") + message.delta;
        transcriptionItemTextRef.current.set(message.item_id, nextText);
        updateParagraph(paragraphId);
        return;
      }

      if (
        message.type === "conversation.item.input_audio_transcription.completed" &&
        message.item_id &&
        message.transcript?.trim()
      ) {
        const paragraphId =
          transcriptionItemParagraphRef.current.get(message.item_id) ??
          registerItem(message.item_id);
        transcriptionItemTextRef.current.set(message.item_id, message.transcript.trim());
        completedTranscriptionItemsRef.current.add(message.item_id);
        updateParagraph(paragraphId);
        return;
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

      if (!response.ok) {
        let message = "Live transcription could not connect.";
        try {
          const result = (await response.json()) as { error?: string };
          message = result.error ?? message;
        } catch {
          // Keep the fallback when the server did not return JSON.
        }
        throw new Error(message);
      }
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
      processedTranscriptionEventsRef.current.clear();
      lastSpeechEndMsRef.current = null;
      activeParagraphIdRef.current = null;
      transcriptionItemParagraphRef.current.clear();
      transcriptionItemTextRef.current.clear();
      completedTranscriptionItemsRef.current.clear();
      paragraphItemIdsRef.current.clear();
      paragraphStartedAtRef.current.clear();
      analysisRequestRef.current += 1;
      setIsThinking(false);
      setInsight("");
      setMode(null);
      setElapsed(0);
      setConnection("device");
      startedAtRef.current = Date.now();
      pausedDurationRef.current = 0;
      setSessionState("recording");

      connectRealtime(stream).catch((issue: unknown) => {
        setConnection("device");
        setError(
          `Recording on this device. ${
            issue instanceof Error
              ? issue.message
              : "Live transcription could not connect."
          }`,
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
    refreshMetaDisplay("chat");
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
          <span className="brand-mark" aria-hidden="true" />
          <span>Meeting Room</span>
        </a>
        <div className="header-status">
          <span className={`status-dot ${sessionState}`} />
          {statusLabel}
        </div>
        <a
          className="display-link"
          href="/display"
          target={META_DISPLAY_WINDOW_NAME}
          rel="opener"
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
            </div>

            <div
              className="transcript-list"
              aria-live="polite"
              ref={transcriptListRef}
              onScroll={(event) => {
                const panel = event.currentTarget;
                transcriptAutoScrollRef.current =
                  panel.scrollHeight - panel.scrollTop - panel.clientHeight < 48;
              }}
            >
              {entries.map((entry) => (
                <article
                  className={`transcript-entry ${entry.kind}${entry.draft ? " draft" : ""}`}
                  key={entry.id}
                >
                  {entry.kind === "note" && (
                    <>
                      <time>{formatTime(entry.time)}</time>
                      <div className="speaker-avatar">✦</div>
                    </>
                  )}
                  <div className="transcript-copy">
                    {entry.kind === "note" && <h3>Meeting note</h3>}
                    <p>
                      <TypewriterText text={entry.text} />
                    </p>
                  </div>
                </article>
              ))}
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
              onClick={() => {
                runAnalysis("topics");
                refreshMetaDisplay("topics");
              }}
            >
              <span aria-hidden="true">⌁</span> Key Topics
            </button>
            <button
              className={mode === "actions" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={mode === "actions"}
              onClick={() => {
                runAnalysis("actions");
                refreshMetaDisplay("actions");
              }}
            >
              <span aria-hidden="true">✓</span> Action Items
            </button>
            <button
              className={mode === "chat" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={mode === "chat"}
              onClick={() => {
                analysisRequestRef.current += 1;
                setIsThinking(false);
                setMode("chat");
                const prompt = "Ask a question about anything discussed in the meeting.";
                setInsight(prompt);
                publishMeta("chat", prompt, false);
                refreshMetaDisplay("chat");
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
            </div>
            {isThinking ? (
              <ThinkingIndicator />
            ) : mode ? (
              <InsightText content={insight} />
            ) : (
              <div className="insight-empty">
                Select Key Topics, Action Items, or Chat to begin.
              </div>
            )}
          </div>

          <p className="panel-note">
            This content is mirrored to Meta Display and refreshes as the conversation continues.
          </p>

          <div className="panel-footer-actions">
            {sessionState === "stopped" && (
              <button
                className="summary-button"
                type="button"
                onClick={() => {
                  runAnalysis("summary");
                  refreshMetaDisplay("summary");
                }}
              >
                Generate meeting summary
              </button>
            )}
            <a
              className="open-display-button"
              href="/display"
              target={META_DISPLAY_WINDOW_NAME}
              rel="opener"
            >
              Present on Meta Display <span aria-hidden="true">↗</span>
            </a>
          </div>
        </aside>
      </div>
    </main>
  );
}
