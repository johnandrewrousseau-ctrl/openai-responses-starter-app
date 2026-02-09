import OpenAI from "openai";

export const runtime = "nodejs";

type PunctuateRequest = {
  text?: string;
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function safeText(x: unknown): string {
  if (typeof x === "string") return x;
  if (x == null) return "";
  return String(x);
}

// Keep this cheap + deterministic.
const DEFAULT_MODEL =
  process.env.MEKA_PUNCTUATE_MODEL || process.env.MEKA_MODEL || "gpt-4o-mini";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Debug logging is OFF by default.
// Turn on by setting MEKA_DEBUG_PUNCTUATE=1 (or MEKA_DEBUG=1)
const PUNCTUATE_DEBUG =
  process.env.MEKA_DEBUG_PUNCTUATE === "1" || process.env.MEKA_DEBUG === "1";

function dbg(...args: any[]) {
  if (PUNCTUATE_DEBUG) console.log(...args);
}

export async function POST(req: Request) {
  dbg("[PUNCTUATE] HIT /api/punctuate");

  try {
    if (!process.env.OPENAI_API_KEY) {
      return json(
        {
          error: "missing_openai_api_key",
          message: "OPENAI_API_KEY is not set on the server.",
        },
        500
      );
    }

    const bodyText = await req.text();
    let parsed: PunctuateRequest | null = null;

    try {
      parsed = bodyText ? (JSON.parse(bodyText) as PunctuateRequest) : null;
    } catch {
      // If client accidentally posts raw text, accept it.
      parsed = { text: bodyText };
    }

    const raw = safeText(parsed?.text).trim();

    // Small guard: don’t waste a call on empty input.
    if (!raw) return json({ text: "" }, 200);

    // Another guard: avoid runaway costs.
    const MAX_CHARS = Number(process.env.MEKA_PUNCTUATE_MAX_CHARS || "5000");
    const clipped = raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) : raw;

    dbg(
      `[PUNCTUATE] model=${DEFAULT_MODEL} in_len=${clipped.length}`
      // Intentionally no previews in logs (clean + privacy)
    );

    const instructions =
      "You are a punctuation and capitalization engine.\n" +
      "Task: add punctuation and capitalization to the user's text.\n" +
      "Rules:\n" +
      "- Do NOT change wording.\n" +
      "- Do NOT add new words.\n" +
      "- Do NOT remove words.\n" +
      "- Preserve the original language.\n" +
      "- Output ONLY the punctuated text, no quotes, no commentary.";

    const resp = await client.responses.create({
      model: DEFAULT_MODEL,
      input: clipped,
      instructions,
      max_output_tokens: 800,
      temperature: 0.2,
    });

    const out = safeText((resp as any).output_text).trim();

    dbg(`[PUNCTUATE] out_len=${out.length || 0}`);

    // If model returns nothing for any reason, fall back safely.
    return json({ text: out || clipped }, 200);
  } catch (e: any) {
    return json(
      {
        error: "punctuate_failed",
        message: safeText(e?.message || e),
      },
      500
    );
  }
}
