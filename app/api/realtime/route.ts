const realtimeSession = {
  type: "realtime",
  model: "gpt-realtime",
  output_modalities: ["text"],
  instructions:
    "You are a silent meeting transcription assistant. Preserve added meeting notes as context. Do not generate a response unless the application explicitly requests one.",
  audio: {
    input: {
      noise_reduction: { type: "far_field" },
      transcription: {
        model: "gpt-4o-mini-transcribe",
        language: "en",
      },
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 250,
        create_response: false,
        interrupt_response: false,
      },
    },
  },
};

export async function POST() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return Response.json(
      { error: "Live transcription is not configured." },
      { status: 503 },
    );
  }

  try {
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
