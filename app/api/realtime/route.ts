type RealtimePreferences = {
  microphoneProfile?: "near_field" | "far_field";
  language?: "en" | "auto";
  sdp?: string;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return Response.json(
      { error: "Live transcription is not configured." },
      { status: 503 },
    );
  }

  try {
    let preferences: RealtimePreferences = {};
    try {
      preferences = (await request.json()) as RealtimePreferences;
    } catch {
      // Use safe defaults when no preferences were supplied.
    }
    const rawSdp = preferences.sdp;
    if (!rawSdp?.trim()) {
      return Response.json(
        { error: "A WebRTC session offer is required." },
        { status: 400 },
      );
    }
    const sdp = `${rawSdp.trim().replace(/\r?\n/g, "\r\n")}\r\n`;

    const microphoneProfile =
      preferences.microphoneProfile === "near_field"
        ? "near_field"
        : "far_field";
    const language = preferences.language === "auto" ? undefined : "en";
    const realtimeSession = {
      type: "transcription",
      audio: {
        input: {
          noise_reduction: { type: microphoneProfile },
          transcription: {
            model: "gpt-realtime-whisper",
            ...(language ? { language } : {}),
            delay: "low",
          },
          turn_detection: null,
        },
      },
    };

    const boundary = `----meeting-room-${crypto.randomUUID()}`;
    const callRequest = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="sdp"',
      "Content-Type: application/sdp",
      "",
      sdp,
      `--${boundary}`,
      'Content-Disposition: form-data; name="session"',
      "Content-Type: application/json",
      "",
      JSON.stringify(realtimeSession),
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const callRequestBytes = new TextEncoder().encode(callRequest);

    const callResponse = await fetch(
      "https://api.openai.com/v1/realtime/calls",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(callRequestBytes.byteLength),
        },
        body: callRequestBytes,
        cache: "no-store",
      },
    );
    const callBody = await callResponse.text();
    return new Response(callBody, {
      status: callResponse.status,
      headers: {
        "Content-Type": callResponse.ok
          ? "application/sdp"
          : "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json(
      { error: "The transcription service could not be reached." },
      { status: 502 },
    );
  }
}
