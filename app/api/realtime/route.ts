export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return Response.json(
      { error: "Live transcription is not configured." },
      { status: 503 },
    );
  }

  const sdp = await request.text();
  if (!sdp) {
    return Response.json({ error: "Missing WebRTC offer." }, { status: 400 });
  }

  const session = {
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
          prompt:
            "Transcribe a business meeting accurately. Preserve names, acronyms, commitments, dates, and decisions.",
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 650,
          create_response: false,
          interrupt_response: false,
        },
      },
    },
  };

  const form = new FormData();
  form.append("sdp", new Blob([sdp], { type: "application/sdp" }), "offer.sdp");
  form.append(
    "session",
    new Blob([JSON.stringify(session)], { type: "application/json" }),
    "session.json",
  );

  try {
    const upstream = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    const body = await upstream.text();
    if (!upstream.ok) {
      return Response.json(
        { error: "Unable to start live transcription.", detail: body },
        { status: upstream.status },
      );
    }

    return new Response(body, {
      status: 201,
      headers: { "Content-Type": "application/sdp" },
    });
  } catch {
    return Response.json(
      { error: "The transcription service could not be reached." },
      { status: 502 },
    );
  }
}
