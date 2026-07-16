type RealtimePreferences = {
  microphoneProfile?: "near_field" | "far_field";
  language?: "en" | "auto";
};

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
            delay: "medium",
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
    return new Response(responseBody, {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
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
