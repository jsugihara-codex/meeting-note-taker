export const runtime = "nodejs";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return Response.json(
      { error: "Final transcript processing is not configured." },
      { status: 503 },
    );
  }

  try {
    const requestBody = await request.formData();
    const audio = requestBody.get("audio");
    const language = requestBody.get("language");
    const terms = requestBody.get("terms");

    if (!(audio instanceof File) || audio.size === 0) {
      return Response.json({ error: "No meeting audio was provided." }, { status: 400 });
    }
    if (audio.size > MAX_AUDIO_BYTES) {
      return Response.json(
        { error: "The meeting audio is too large for the final accuracy pass." },
        { status: 413 },
      );
    }

    const upstreamBody = new FormData();
    upstreamBody.append("file", audio, audio.name || "meeting.webm");
    upstreamBody.append("model", "gpt-4o-transcribe");
    upstreamBody.append("response_format", "json");
    if (language === "en") upstreamBody.append("language", "en");
    if (typeof terms === "string" && terms.trim()) {
      upstreamBody.append(
        "prompt",
        `Use the following names, acronyms, and specialized terms when they match the audio: ${terms.trim()}`,
      );
    }

    const upstream = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstreamBody,
      cache: "no-store",
    });

    const responseText = await upstream.text();
    if (!upstream.ok) {
      let error = "The final accuracy pass could not be completed.";
      try {
        const result = JSON.parse(responseText) as {
          error?: { message?: string } | string;
        };
        error =
          typeof result.error === "string"
            ? result.error
            : result.error?.message ?? error;
      } catch {
        // Keep the user-friendly fallback when the upstream response is not JSON.
      }
      return Response.json({ error }, { status: upstream.status });
    }

    const result = JSON.parse(responseText) as { text?: string };
    const text = result.text?.trim();
    if (!text) {
      return Response.json(
        { error: "No speech was found in the recorded audio." },
        { status: 422 },
      );
    }

    return Response.json(
      { text },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "The recorded audio could not be processed." },
      { status: 502 },
    );
  }
}
