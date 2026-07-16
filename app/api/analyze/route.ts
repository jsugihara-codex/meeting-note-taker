type AnalyzeRequest = {
  mode?: "chat" | "summary";
  transcript?: string;
  question?: string;
};

const instructions = {
  chat:
    "Answer the user's question using only the meeting transcript and timestamped notes. Treat every USER-ADDED NOTE as authoritative context at its stated timestamp. Be concise. If the answer is not in the meeting, say that clearly.",
  summary:
    "Create a concise, useful meeting summary using only the transcript and timestamped notes. Use the headings Outcome, Key decisions, Next steps, and Notes. Treat every USER-ADDED NOTE as authoritative context anchored at its stated timestamp. Include every user-added note with its timestamp under Notes, and also incorporate its context into the relevant Outcome, Key decisions, or Next steps sections. Do not invent decisions, owners, deadlines, or action items.",
} as const;

type OpenAIResponse = {
  status?: string;
  incomplete_details?: { reason?: string };
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: { code?: string; message?: string; type?: string };
};

const analysisModels = ["gpt-5-mini", "gpt-4.1-mini"] as const;

function responseText(result: OpenAIResponse) {
  return result.output
    ?.flatMap((item) => item.content ?? [])
    .filter((content) => !content.type || content.type === "output_text")
    .map((content) => content.text ?? "")
    .join("\n")
    .trim();
}

function canRetryWithFallback(status: number, result: OpenAIResponse) {
  return (
    status === 400 ||
    status === 403 ||
    status === 404 ||
    result.error?.code === "model_not_found" ||
    result.error?.type === "invalid_request_error"
  );
}

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
  const mode = body.mode === "summary" ? "summary" : "chat";
  if (!transcript || (mode === "chat" && !question)) {
    return Response.json(
      {
        error:
          mode === "summary"
            ? "Meeting content is required."
            : "A transcript and chat question are required.",
      },
      { status: 400 },
    );
  }

  const timestampedNotes = transcript
    .split("\n")
    .filter((line) => line.includes("USER-ADDED NOTE AT THIS POINT"));
  const meetingContent =
    transcript.length > 120_000
      ? [
          "[Earlier transcript content was shortened to fit the analysis window.]",
          transcript.slice(-120_000),
          timestampedNotes.length
            ? `All timestamped user-added notes:\n${timestampedNotes.join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n")
      : transcript;

  const prompt = [
    `Task: ${instructions[mode]}`,
    mode === "chat" ? `Question: ${question}` : "Format: concise and scannable",
    "Meeting content:",
    meetingContent,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    let lastError = "The meeting response could not be generated.";
    let lastStatus = 502;

    for (const [index, model] of analysisModels.entries()) {
      const upstream = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: prompt,
          max_output_tokens: 1200,
          ...(model === "gpt-5-mini"
            ? { reasoning: { effort: "minimal" } }
            : {}),
        }),
        cache: "no-store",
      });

      const rawResponse = await upstream.text();
      let result: OpenAIResponse = {};
      try {
        result = JSON.parse(rawResponse) as OpenAIResponse;
      } catch {
        lastError = "OpenAI returned an unreadable response.";
      }

      if (upstream.ok) {
        const text = responseText(result);
        if (text) {
          return Response.json(
            { text },
            { headers: { "Cache-Control": "no-store" } },
          );
        }
        lastError =
          result.status === "incomplete"
            ? `The response was incomplete${
                result.incomplete_details?.reason
                  ? `: ${result.incomplete_details.reason}`
                  : "."
              }`
            : "OpenAI returned an empty response.";
        lastStatus = 502;
      } else {
        lastError = result.error?.message ?? lastError;
        lastStatus = upstream.status;
      }

      const hasFallback = index < analysisModels.length - 1;
      if (
        !hasFallback ||
        (!upstream.ok && !canRetryWithFallback(upstream.status, result))
      ) {
        break;
      }
    }

    return Response.json({ error: lastError }, { status: lastStatus });
  } catch {
    return Response.json(
      { error: "The meeting intelligence service could not be reached." },
      { status: 502 },
    );
  }
}
