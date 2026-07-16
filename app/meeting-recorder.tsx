"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type SessionState = "idle" | "connecting" | "recording" | "paused" | "stopped";
type InsightMode = "chat" | "summary";
type DisplayMode = InsightMode | "idle";
type MicrophoneProfile = "far_field" | "near_field";
type TranscriptionLanguage = "en" | "auto";
type FinalizationState = "idle" | "processing" | "complete";

type TranscriptEntry = {
  id: string;
  time: number;
  speaker: string;
  text: string;
  kind: "speech" | "note";
  draft?: boolean;
};

type MetaState = {
  sequence: number;
  mode: DisplayMode;
  title: string;
  content: string;
  isThinking: boolean;
  updatedAt: number;
  meetingStatus: SessionState;
};

const META_DISPLAY_WINDOW_NAME = "meeting-room-meta-display";
const AUDIO_COMMIT_INTERVAL_MS = 2200;
const LOCAL_AUDIO_SEGMENT_MS = 5 * 60 * 1000;
const RECORDER_AUDIO_BITS_PER_SECOND = 48_000;
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

function mediaRecorderOptions(): MediaRecorderOptions {
  const preferredTypes = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
  ];
  const mimeType = preferredTypes.find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
  return {
    ...(mimeType ? { mimeType } : {}),
    audioBitsPerSecond: RECORDER_AUDIO_BITS_PER_SECOND,
  };
}

function audioFileExtension(mimeType: string) {
  return mimeType.includes("mp4") ? "m4a" : "webm";
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard unavailable");
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
  if (mode === "summary") return "Meeting summary";
  return mode === "chat" ? "Meeting answer" : "Transcript chat";
}

function TypewriterText({ text }: { text: string }) {
  const [visibleText, setVisibleText] = useState("");
  const visibleTextRef = useRef("");
  const targetTextRef = useRef(text);
  const typingFrameRef = useRef<number | null>(null);

  useEffect(() => {
    targetTextRef.current = text;
    if (typingFrameRef.current !== null) return;

    const typeNextCharacter = () => {
      const target = targetTextRef.current;
      const current = visibleTextRef.current;
      let next = current;

      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        next = target;
      } else if (!target.startsWith(current)) {
        let sharedPrefixLength = 0;
        const maxPrefixLength = Math.min(current.length, target.length);
        while (
          sharedPrefixLength < maxPrefixLength &&
          current[sharedPrefixLength] === target[sharedPrefixLength]
        ) {
          sharedPrefixLength += 1;
        }
        next = target.slice(0, sharedPrefixLength);
      } else if (current.length < target.length) {
        next = target.slice(0, current.length + 1);
      }

      if (next !== current) {
        visibleTextRef.current = next;
        setVisibleText(next);
      }

      if (next !== target) {
        typingFrameRef.current = window.requestAnimationFrame(typeNextCharacter);
      } else {
        typingFrameRef.current = null;
      }
    };

    typingFrameRef.current = window.requestAnimationFrame(typeNextCharacter);
  }, [text]);

  useEffect(
    () => () => {
      if (typingFrameRef.current !== null) {
        window.cancelAnimationFrame(typingFrameRef.current);
      }
    },
    [],
  );

  const isTyping = visibleText !== text;
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
  const [mode, setMode] = useState<InsightMode | null>("chat");
  const [insight, setInsight] = useState("");
  const [question, setQuestion] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [hasCopiedInsight, setHasCopiedInsight] = useState(false);
  const [connection, setConnection] = useState<"preview" | "live" | "device">(
    "preview",
  );
  const [microphoneProfile, setMicrophoneProfile] =
    useState<MicrophoneProfile>("far_field");
  const [transcriptionLanguage, setTranscriptionLanguage] =
    useState<TranscriptionLanguage>("en");
  const [transcriptionTerms, setTranscriptionTerms] = useState("");
  const [finalizationState, setFinalizationState] =
    useState<FinalizationState>("idle");
  const [error, setError] = useState("");

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const outboundMicrophoneTrackRef = useRef<MediaStreamTrack | null>(null);
  const audioCommitTimerRef = useRef<number | null>(null);
  const localAudioSegmentTimerRef = useRef<number | null>(null);
  const recordedAudioSegmentsRef = useRef<Blob[]>([]);
  const continueAudioSegmentsRef = useRef(false);
  const deviceRecorderStoppedRef = useRef(Promise.resolve());
  const startDeviceRecorderRef = useRef<(stream: MediaStream) => void>(() => undefined);
  const lastAudioCommitAtRef = useRef(0);
  const metaSequenceRef = useRef(0);
  const metaPublishChainRef = useRef(Promise.resolve());
  const startedAtRef = useRef(0);
  const pausedAtRef = useRef(0);
  const pausedDurationRef = useRef(0);
  const elapsedRef = useRef(0);
  const sessionStateRef = useRef<SessionState>(sessionState);
  const analysisRequestRef = useRef(0);
  const transcriptListRef = useRef<HTMLDivElement | null>(null);
  const transcriptAutoScrollRef = useRef(true);
  const processedTranscriptionEventsRef = useRef(new Set<string>());
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
    ): Promise<void> => {
      metaSequenceRef.current = Math.max(
        Date.now(),
        metaSequenceRef.current + 1,
      );
      const payload: MetaState = {
        sequence: metaSequenceRef.current,
        mode: nextMode ?? "idle",
        title: modeTitle(nextMode),
        content: nextContent,
        isThinking: nextIsThinking,
        updatedAt: Date.now(),
        meetingStatus: sessionStateRef.current,
      };
      metaPublishChainRef.current = metaPublishChainRef.current
        .catch(() => undefined)
        .then(async () => {
          const response = await fetch("/api/meta-state", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            keepalive: true,
          });
          if (!response.ok) {
            throw new Error("The Meta Display relay is unavailable.");
          }
          const result = (await response.json()) as {
            state?: { sequence?: number };
          };
          if (Number.isSafeInteger(result.state?.sequence)) {
            metaSequenceRef.current = Math.max(
              metaSequenceRef.current,
              Number(result.state?.sequence),
            );
          }
        })
        .catch(() => undefined);
      return metaPublishChainRef.current;
    },
    [],
  );

  useEffect(() => {
    publishMeta(mode, insight, isThinking);
  }, [insight, isThinking, mode, publishMeta, sessionState]);

  useEffect(() => {
    if (sessionState !== "recording" && sessionState !== "paused") return;
    const heartbeat = window.setInterval(
      () => publishMeta(mode, insight, isThinking),
      2000,
    );
    return () => window.clearInterval(heartbeat);
  }, [insight, isThinking, mode, publishMeta, sessionState]);

  const createTranscriptParagraph = useCallback(() => {
    const paragraphId = crypto.randomUUID();
    activeParagraphIdRef.current = paragraphId;
    paragraphStartedAtRef.current.set(paragraphId, elapsedRef.current);
    paragraphItemIdsRef.current.set(paragraphId, []);
    return paragraphId;
  }, []);

  const transcriptForAnalysis = useCallback((source = entries) => {
    return source
      .map((entry, index) => ({ entry, index }))
      .sort(
        (left, right) =>
          left.entry.time - right.entry.time || left.index - right.index,
      )
      .map(({ entry }) =>
        entry.kind === "note"
          ? `[${formatTime(entry.time)}] USER-ADDED NOTE AT THIS POINT IN THE MEETING: ${entry.text}`
          : `[${formatTime(entry.time)}] TRANSCRIPT: ${entry.text}`,
      )
      .join("\n");
  }, [entries]);

  const runAnalysis = useCallback(
    async (nextMode: InsightMode, nextQuestion = "", source = entries) => {
      const requestId = ++analysisRequestRef.current;
      setError("");
      setMode(nextMode);
      setInsight("");
      setIsThinking(true);
      setHasCopiedInsight(false);
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
        const result = (await response.json()) as {
          text?: string;
          error?: string;
        };
        if (!response.ok || !result.text) {
          throw new Error(
            result.error ?? "The meeting response could not be generated.",
          );
        }
        if (requestId === analysisRequestRef.current) {
          setInsight(result.text);
          setIsThinking(false);
          publishMeta(nextMode, result.text, false);
        }
      } catch (issue) {
        if (requestId === analysisRequestRef.current) {
          const message =
            issue instanceof Error
              ? issue.message
              : nextMode === "summary"
                ? "A meeting summary could not be generated. Please try again."
                : "An answer could not be generated. Please try again.";
          setError(message);
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

  const handleRealtimeEvent = useCallback((event: MessageEvent<string>) => {
    try {
      if (sessionStateRef.current === "stopped") return;
      const message = JSON.parse(event.data) as {
        type?: string;
        event_id?: string;
        item_id?: string;
        audio_start_ms?: number;
        audio_end_ms?: number;
        delta?: string;
        transcript?: string;
        error?: { code?: string; message?: string };
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

      const createParagraph = createTranscriptParagraph;
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
        const errorMessage =
          message.error?.message ?? "Live transcription had a recoverable error.";
        if (/buffer (?:is )?(?:empty|too small)/i.test(errorMessage)) return;
        setError(errorMessage);
      }
    } catch {
      // Ignore non-JSON WebRTC control events.
    }
  }, [createTranscriptParagraph]);

  const stopAudioCommits = useCallback(() => {
    if (audioCommitTimerRef.current !== null) {
      window.clearInterval(audioCommitTimerRef.current);
      audioCommitTimerRef.current = null;
    }
  }, []);

  const stopLocalAudioSegments = useCallback(() => {
    if (localAudioSegmentTimerRef.current !== null) {
      window.clearInterval(localAudioSegmentTimerRef.current);
      localAudioSegmentTimerRef.current = null;
    }
  }, []);

  const startDeviceRecorder = useCallback((stream: MediaStream) => {
    const segmentChunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, mediaRecorderOptions());
    let resolveRecorderStopped: () => void = () => undefined;
    deviceRecorderStoppedRef.current = new Promise<void>((resolve) => {
      resolveRecorderStopped = () => resolve();
    });
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) segmentChunks.push(event.data);
    };
    recorder.onstop = () => {
      if (segmentChunks.length > 0) {
        recordedAudioSegmentsRef.current.push(
          new Blob(segmentChunks, {
            type:
              recorder.mimeType ||
              segmentChunks[0]?.type ||
              "audio/webm",
          }),
        );
      }
      if (continueAudioSegmentsRef.current && stream.active) {
        startDeviceRecorderRef.current(stream);
      }
      resolveRecorderStopped();
    };
    recorder.start(1000);
  }, []);

  useEffect(() => {
    startDeviceRecorderRef.current = startDeviceRecorder;
  }, [startDeviceRecorder]);

  const commitAudioBuffer = useCallback((channel = dataChannelRef.current) => {
    if (
      channel?.readyState !== "open" ||
      sessionStateRef.current !== "recording"
    ) {
      return;
    }
    channel.send(
      JSON.stringify({
        type: "input_audio_buffer.commit",
        event_id: crypto.randomUUID(),
      }),
    );
    lastAudioCommitAtRef.current = Date.now();
  }, []);

  const startAudioCommits = useCallback(
    (channel: RTCDataChannel) => {
      stopAudioCommits();
      lastAudioCommitAtRef.current = Date.now();
      audioCommitTimerRef.current = window.setInterval(
        () => commitAudioBuffer(channel),
        AUDIO_COMMIT_INTERVAL_MS,
      );
    },
    [commitAudioBuffer, stopAudioCommits],
  );

  const connectRealtime = useCallback(
    async (stream: MediaStream) => {
      const tokenResponse = await fetch("/api/realtime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          microphoneProfile,
          language: transcriptionLanguage,
        }),
      });
      const tokenData = (await tokenResponse.json()) as {
        value?: string;
        client_secret?: { value?: string };
        error?: { message?: string } | string;
      };
      const clientSecret = tokenData.value ?? tokenData.client_secret?.value;
      if (!tokenResponse.ok || !clientSecret) {
        const tokenError =
          typeof tokenData.error === "string"
            ? tokenData.error
            : tokenData.error?.message;
        throw new Error(tokenError ?? "Live transcription could not connect.");
      }

      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      const sourceTrack = stream.getAudioTracks()[0];
      if (!sourceTrack) {
        peer.close();
        peerRef.current = null;
        throw new Error("No microphone track is available.");
      }
      const outboundTrack = sourceTrack.clone();
      outboundMicrophoneTrackRef.current = outboundTrack;
      peer.addTrack(outboundTrack, new MediaStream([outboundTrack]));
      peer.onconnectionstatechange = () => {
        if (sessionStateRef.current !== "recording") return;
        if (
          peer.connectionState === "failed" ||
          peer.connectionState === "disconnected"
        ) {
          stopAudioCommits();
          setConnection("device");
          setError("Recording continues on this device. Live transcription disconnected.");
        }
      };

      const channel = peer.createDataChannel("oai-events");
      dataChannelRef.current = channel;
      channel.onmessage = handleRealtimeEvent;
      channel.onopen = () => {
        setConnection("live");
        startAudioCommits(channel);
      };
      channel.onclose = stopAudioCommits;

      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        const response = await fetch("https://api.openai.com/v1/realtime/calls", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${clientSecret}`,
            "Content-Type": "application/sdp",
          },
          body: peer.localDescription?.sdp ?? offer.sdp,
        });

        if (!response.ok) {
          let message = "Live transcription could not connect.";
          try {
            const result = (await response.json()) as {
              error?: { message?: string } | string;
            };
            message =
              typeof result.error === "string"
                ? result.error
                : result.error?.message ?? message;
          } catch {
            // Keep the fallback when the server did not return JSON.
          }
          throw new Error(message);
        }
        const answerSdp = await response.text();
        await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
      } catch (issue) {
        stopAudioCommits();
        channel.close();
        peer.close();
        outboundTrack.stop();
        if (dataChannelRef.current === channel) dataChannelRef.current = null;
        if (peerRef.current === peer) peerRef.current = null;
        if (outboundMicrophoneTrackRef.current === outboundTrack) {
          outboundMicrophoneTrackRef.current = null;
        }
        throw issue;
      }
    },
    [
      handleRealtimeEvent,
      microphoneProfile,
      startAudioCommits,
      stopAudioCommits,
      transcriptionLanguage,
    ],
  );

  const finalizeTranscript = useCallback(
    async (segments: Blob[]) => {
      if (segments.length === 0) return false;

      const transcripts = await Promise.all(
        segments.map(async (segment, index) => {
          const requestBody = new FormData();
          const extension = audioFileExtension(segment.type);
          requestBody.append(
            "audio",
            new File([segment], `meeting-${index + 1}.${extension}`, {
              type: segment.type,
            }),
          );
          requestBody.append("language", transcriptionLanguage);
          if (transcriptionTerms.trim()) {
            requestBody.append("terms", transcriptionTerms.trim());
          }

          const response = await fetch("/api/transcribe", {
            method: "POST",
            body: requestBody,
          });
          const result = (await response.json()) as {
            text?: string;
            error?: string;
          };
          if (response.status === 422) return "";
          if (!response.ok) {
            throw new Error(
              result.error ?? "The final accuracy pass could not be completed.",
            );
          }
          return result.text?.trim() ?? "";
        }),
      );

      const finalText = mergeTranscriptChunks(transcripts.filter(Boolean));
      if (!finalText) return false;

      setEntries((current) => {
        const firstSpeech = current.find((entry) => entry.kind === "speech");
        const firstSpeechTime =
          firstSpeech?.time ?? 0;
        const notes = current.filter((entry) => entry.kind === "note");
        return [
          {
            id: firstSpeech?.id ?? `final-transcript-${crypto.randomUUID()}`,
            time: firstSpeechTime,
            speaker: "Transcript",
            text: finalText,
            kind: "speech" as const,
            draft: false,
          },
          ...notes,
        ].sort((left, right) => left.time - right.time);
      });
      return true;
    },
    [transcriptionLanguage, transcriptionTerms],
  );

  const startRecording = async () => {
    setError("");
    setFinalizationState("idle");
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

      recordedAudioSegmentsRef.current = [];
      continueAudioSegmentsRef.current = true;
      startDeviceRecorder(stream);
      stopLocalAudioSegments();
      localAudioSegmentTimerRef.current = window.setInterval(() => {
        const recorder = recorderRef.current;
        if (recorder?.state === "recording") recorder.stop();
      }, LOCAL_AUDIO_SEGMENT_MS);

      setEntries([]);
      processedTranscriptionEventsRef.current.clear();
      activeParagraphIdRef.current = null;
      transcriptionItemParagraphRef.current.clear();
      transcriptionItemTextRef.current.clear();
      completedTranscriptionItemsRef.current.clear();
      paragraphItemIdsRef.current.clear();
      paragraphStartedAtRef.current.clear();
      analysisRequestRef.current += 1;
      setIsThinking(false);
      setInsight("");
      setQuestion("");
      setMode("chat");
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
      continueAudioSegmentsRef.current = false;
      stopLocalAudioSegments();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
      setSessionState("idle");
      setError("Microphone access is needed to start recording.");
    }
  };

  const pauseRecording = () => {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") recorder.pause();
    if (Date.now() - lastAudioCommitAtRef.current > 150) {
      commitAudioBuffer();
    }
    stopAudioCommits();
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
    if (outboundMicrophoneTrackRef.current) {
      outboundMicrophoneTrackRef.current.enabled = false;
    }
    pausedAtRef.current = Date.now();
    setSessionState("paused");
  };

  const resumeRecording = () => {
    const recorder = recorderRef.current;
    if (recorder?.state === "paused") recorder.resume();
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    if (outboundMicrophoneTrackRef.current) {
      outboundMicrophoneTrackRef.current.enabled = true;
    }
    pausedDurationRef.current += Date.now() - pausedAtRef.current;
    startedAtRef.current =
      Date.now() - elapsedRef.current * 1000 - pausedDurationRef.current;
    setSessionState("recording");
    const channel = dataChannelRef.current;
    if (channel?.readyState === "open") startAudioCommits(channel);
  };

  const stopRecording = async () => {
    const channel = dataChannelRef.current;
    if (
      sessionStateRef.current === "recording" &&
      Date.now() - lastAudioCommitAtRef.current > 150
    ) {
      commitAudioBuffer(channel);
    }
    stopAudioCommits();
    stopLocalAudioSegments();
    continueAudioSegmentsRef.current = false;

    const recorder = recorderRef.current;
    const recorderStopped = deviceRecorderStoppedRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();

    if (outboundMicrophoneTrackRef.current) {
      outboundMicrophoneTrackRef.current.enabled = false;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    const peer = peerRef.current;
    const outboundTrack = outboundMicrophoneTrackRef.current;
    window.setTimeout(() => {
      channel?.close();
      peer?.close();
      outboundTrack?.stop();
    }, 1500);
    streamRef.current = null;
    recorderRef.current = null;
    dataChannelRef.current = null;
    peerRef.current = null;
    outboundMicrophoneTrackRef.current = null;
    sessionStateRef.current = "stopped";
    setSessionState("stopped");
    setNoteOpen(false);
    setFinalizationState("processing");

    try {
      await recorderStopped;
      const finalized = await finalizeTranscript([
        ...recordedAudioSegmentsRef.current,
      ]);
      setFinalizationState(finalized ? "complete" : "idle");
    } catch (issue) {
      setFinalizationState("idle");
      setError(
        `The live transcript was kept. ${
          issue instanceof Error
            ? issue.message
            : "The final accuracy pass could not be completed."
        }`,
      );
    }
  };

  useEffect(() => {
    return () => {
      stopAudioCommits();
      stopLocalAudioSegments();
      continueAudioSegmentsRef.current = false;
      if (recorderRef.current?.state !== "inactive") {
        recorderRef.current?.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      outboundMicrophoneTrackRef.current?.stop();
      dataChannelRef.current?.close();
      peerRef.current?.close();
    };
  }, [stopAudioCommits, stopLocalAudioSegments]);

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
  };

  const askQuestion = (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text) return;
    runAnalysis("chat", text);
  };

  const copyInsight = async () => {
    if (!insight.trim()) return;
    try {
      const plainText = insight
        .replace(/\*\*/g, "")
        .replace(/^[-*•]\s*/gm, "• ")
        .trim();
      await writeClipboardText(plainText);
      setHasCopiedInsight(true);
      window.setTimeout(() => setHasCopiedInsight(false), 1800);
    } catch {
      setError("The summary could not be copied. Please select and copy the text manually.");
    }
  };

  const statusLabel =
    finalizationState === "processing"
      ? "Improving transcript accuracy"
      : sessionState === "recording"
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
  const settingsDisabled =
    sessionState === "connecting" || finalizationState === "processing";

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

            {!isActive && (
              <div className="transcription-settings" aria-label="Transcription settings">
                <label>
                  <span>Microphone</span>
                  <select
                    value={microphoneProfile}
                    onChange={(event) =>
                      setMicrophoneProfile(event.target.value as MicrophoneProfile)
                    }
                    disabled={settingsDisabled}
                  >
                    <option value="far_field">Laptop or room mic</option>
                    <option value="near_field">Headset or close phone</option>
                  </select>
                </label>
                <label>
                  <span>Language</span>
                  <select
                    value={transcriptionLanguage}
                    onChange={(event) =>
                      setTranscriptionLanguage(
                        event.target.value as TranscriptionLanguage,
                      )
                    }
                    disabled={settingsDisabled}
                  >
                    <option value="en">English</option>
                    <option value="auto">Auto detect</option>
                  </select>
                </label>
                <label className="terms-setting">
                  <span>Names &amp; terms <small>optional</small></span>
                  <input
                    value={transcriptionTerms}
                    onChange={(event) => setTranscriptionTerms(event.target.value)}
                    placeholder="e.g. Sugihara, BIDI, Vercel"
                    disabled={settingsDisabled}
                  />
                </label>
              </div>
            )}

            <div className="recording-controls">
              {!isActive ? (
                <button
                  className="record-button start"
                  type="button"
                  onClick={startRecording}
                  disabled={settingsDisabled}
                >
                  <span className="mic-symbol" aria-hidden="true" />
                  {finalizationState === "processing"
                    ? "Improving transcript…"
                    : sessionState === "connecting"
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
              {finalizationState !== "idle" && (
                <span className={`transcript-quality ${finalizationState}`}>
                  {finalizationState === "processing"
                    ? "Improving accuracy…"
                    : "Accuracy pass complete"}
                </span>
              )}
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
                      <TypewriterText
                        text={
                          entry.kind === "speech"
                            ? entry.text.toLocaleUpperCase("en-US")
                            : entry.text
                        }
                      />
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
              <p className="eyebrow">Transcript chat</p>
              <h2>Ask about the meeting</h2>
            </div>
          </div>

          <div className="summary-action">
            <button
              className="summary-button"
              type="button"
              onClick={() => runAnalysis("summary")}
              disabled={
                entries.length === 0 ||
                isThinking ||
                finalizationState === "processing"
              }
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3.5 13.6 8l4.4 1.6-4.4 1.6L12 15.5l-1.6-4.3L6 9.6 10.4 8 12 3.5Z" />
                <path d="m18.5 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
              </svg>
              {isThinking && mode === "summary"
                ? "Generating summary…"
                : mode === "summary" && insight
                  ? "Regenerate summary"
                  : "Summarize meeting"}
            </button>
            <p>Includes the transcript and every note at its recorded timestamp.</p>
          </div>

          <form className="chat-composer" onSubmit={askQuestion}>
            <label htmlFor="meeting-question">Ask about the transcript</label>
            <div>
              <input
                id="meeting-question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="What is blocking the launch?"
              />
              <button
                type="submit"
                disabled={!question.trim() || isThinking}
                aria-label="Ask question"
              >
                ↑
              </button>
            </div>
          </form>

          <div className="meta-preview">
            <div className="meta-preview-header">
              <span>{mode === "summary" ? "Meeting summary" : "Answer"}</span>
              {mode === "summary" && insight && !isThinking && (
                <button
                  className={`copy-insight-button${hasCopiedInsight ? " copied" : ""}`}
                  type="button"
                  onClick={copyInsight}
                  aria-label={hasCopiedInsight ? "Summary copied" : "Copy summary"}
                  title={hasCopiedInsight ? "Copied" : "Copy summary"}
                >
                  {hasCopiedInsight ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m5 12.5 4.2 4.2L19 7" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="8" y="8" width="11" height="11" rx="2" />
                      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                    </svg>
                  )}
                </button>
              )}
            </div>
            {isThinking ? (
              <ThinkingIndicator />
            ) : insight ? (
              <InsightText content={insight} />
            ) : (
              <div className="insight-empty">
                {mode === "summary"
                  ? "Generate a summary to see the meeting outcome, decisions, next steps, and timestamped notes."
                  : "Ask a question about the transcript to see the answer here."}
              </div>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}
