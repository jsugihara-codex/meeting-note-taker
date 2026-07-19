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
    const sdp = preferences.sdp?.trim();
    if (!sdp) {
      return Response.json(
        { error: "A WebRTC session offer is required." },
        { status: 400 },
      );
    }

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

    const upstream = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ session: realtimeSession }),
        cache: "no-store",
      },
    );

    const responseBody = await upstream.text();
    if (!upstream.ok) {
      return new Response(responseBody, {
        status: upstream.status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    let clientSecret = "";
    try {
      const tokenData = JSON.parse(responseBody) as {
        value?: string;
        client_secret?: { value?: string };
      };
      clientSecret =
        tokenData.value ?? tokenData.client_secret?.value ?? "";
    } catch {
      // Return a controlled error instead of exposing an unexpected response.
    }
    if (!clientSecret) {
      return Response.json(
        { error: "A Realtime session could not be authorized." },
        { status: 502 },
      );
    }

    const callResponse = await fetch(
      "https://api.openai.com/v1/realtime/calls",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          "Content-Type": "application/sdp",
        },
        body: sdp,
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
