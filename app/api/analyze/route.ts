type AnalyzeRequest = {
  mode?: "chat";
  transcript?: string;
  question?: string;
};

const instruction =
  "Answer the user's question using only the meeting transcript and notes. Be concise. If the answer is not in the meeting, say that clearly.";

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Meeting intelligence is not configured." },
      { status: 503 },
    );
  }

  let body: AnalyzeRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const transcript = body.transcript?.trim();
  const question = body.question?.trim();
  if (!transcript || !question || (body.mode && body.mode !== "chat")) {
    return Response.json(
      { error: "A transcript and chat question are required." },
      { status: 400 },
    );
  }

  const prompt = [
    `Task: ${instruction}`,
    `Question: ${question}`,
    "Meeting content:",
    transcript.slice(-24000),
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        input: prompt,
        max_output_tokens: 700,
      }),
    });

    const result = (await upstream.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
      error?: { message?: string };
    };

    if (!upstream.ok) {
      return Response.json(
        { error: result.error?.message ?? "Analysis failed." },
        { status: upstream.status },
      );
    }

    const text =
      result.output_text ??
      result.output
        ?.flatMap((item) => item.content ?? [])
        .map((content) => content.text ?? "")
        .join("\n")
        .trim();

    return Response.json({ text: text || "No result was returned." });
  } catch {
    return Response.json(
      { error: "The meeting intelligence service could not be reached." },
      { status: 502 },
    );
  }
}
