type AnalyzeRequest = {
  mode?: "chat" | "summary";
  transcript?: string;
  question?: string;
  notes?: Array<{
    timestamp?: string;
    text?: string;
  }>;
  chats?: Array<{
    timestamp?: string;
    question?: string;
    answer?: string;
  }>;
};

const instructions = {
  chat:
    "Answer the user's question using only the spoken meeting transcript, the separate explicit user notes, and prior meeting-chat questions and answers. Treat every explicit user note as authoritative context at its stated timestamp. Be concise. If the answer is not in the provided meeting content, say that clearly.",
  summary:
    "Create a concise, useful meeting summary using only the spoken transcript, the separate explicit user notes, and the meeting-chat questions and answers. Use the headings Key topics, Key decisions, Next steps, and Notes, in that order. Under Key topics, identify every material high-level category or subject covered, consolidate repeated discussion into the same category, and give each category enough context to understand the discussion. Format each category exactly as a bold Markdown headline on its own line, such as **Launch planning**, followed on the next line by one concise paragraph of no more than four complete sentences. Do not use bullets for the bold topic headlines and do not write a separate outcome paragraph. Under Key decisions and Next steps, use concise bullets. Under Notes, list exactly and only the explicit notes entered in the Meeting notes field, preserving every timestamp. Never infer a note from spoken transcript or chat text and never copy or relabel transcript or chat text as a user-added note. If there are no explicit notes, write 'No user-added notes.' under Notes. Explicit notes may also inform Key topics, Key decisions, or Next steps. Do not invent topics, decisions, owners, deadlines, action items, or notes.",
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
  const explicitNotes = Array.isArray(body.notes)
    ? body.notes
        .map((note) => ({
          timestamp: note.timestamp?.trim() ?? "",
          text: note.text?.trim() ?? "",
        }))
        .filter((note) => note.text)
        .slice(0, 500)
    : [];
  const chatExchanges = Array.isArray(body.chats)
    ? body.chats
        .map((chat) => ({
          timestamp: chat.timestamp?.trim() ?? "",
          question: (chat.question?.trim() ?? "").slice(0, 4_000),
          answer: (chat.answer?.trim() ?? "").slice(0, 8_000),
        }))
        .filter((chat) => chat.question || chat.answer)
        .slice(-200)
    : [];
  const mode = body.mode === "summary" ? "summary" : "chat";
  if (
    (!transcript && explicitNotes.length === 0 && chatExchanges.length === 0) ||
    (mode === "chat" && !question)
  ) {
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

  const meetingTranscript =
    (transcript?.length ?? 0) > 120_000
      ? [
          "[Earlier spoken transcript content was shortened to fit the analysis window.]",
          transcript?.slice(-120_000) ?? "",
        ].join("\n")
      : transcript || "[No spoken transcript was captured.]";
  const notesContent = explicitNotes.length
    ? explicitNotes
        .map(
          (note) =>
            `[${note.timestamp || "timestamp unavailable"}] ${note.text}`,
        )
        .join("\n")
    : "[No explicit user notes were added.]";
  const chatContent = chatExchanges.length
    ? chatExchanges
        .map(
          (chat) =>
            `[${chat.timestamp || "timestamp unavailable"}]\nQuestion: ${
              chat.question || "[No question recorded.]"
            }\nAnswer: ${chat.answer || "[No answer recorded.]"}`,
        )
        .join("\n\n")
    : "[No meeting-chat exchanges were recorded.]";

  const prompt = [
    `Task: ${instructions[mode]}`,
    mode === "chat" ? `Question: ${question}` : "Format: concise and scannable",
    "Spoken meeting transcript only:",
    meetingTranscript,
    "Explicit user notes entered through the Meeting notes field only:",
    notesContent,
    "Meeting-chat questions and generated answers:",
    chatContent,
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
