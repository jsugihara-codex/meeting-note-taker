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
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.6,
          prefix_padding_ms: 300,
          silence_duration_ms: 250,
          create_response: false,
          interrupt_response: false,
        },
      },
    },
  };

  // OpenAI expects both values as multipart fields, not file uploads. FormData
  // adds a filename for Blob values, which causes the Realtime API to ignore
  // the SDP field, so build the two typed fields explicitly.
  const boundary = `----meeting-room-${crypto.randomUUID()}`;
  const body = [
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="sdp"\r\n',
    "Content-Type: application/sdp\r\n\r\n",
    sdp,
    "\r\n",
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="session"\r\n',
    "Content-Type: application/json\r\n\r\n",
    JSON.stringify(session),
    "\r\n",
    `--${boundary}--\r\n`,
  ].join("");

  try {
    const upstream = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    const responseBody = await upstream.text();
    if (!upstream.ok) {
      let detail = "Unable to start live transcription.";
      try {
        const parsed = JSON.parse(responseBody) as {
          error?: { message?: string };
        };
        detail = parsed.error?.message ?? detail;
      } catch {
        // Keep the safe fallback when the upstream response is not JSON.
      }
      return Response.json(
        { error: detail },
        { status: upstream.status },
      );
    }

    return new Response(responseBody, {
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
