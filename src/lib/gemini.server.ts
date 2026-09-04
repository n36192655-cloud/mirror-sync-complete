/**
 * اتصال Gemini المشترك.
 * Meter Reading Pipeline يستخدم نموذجًا ثابتًا وطلبًا واحدًا لكل صورة.
 */
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

export const GEMINI_MODEL = "gemini-3.7-flash" as const;

export class GeminiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
  }
}

export interface GeminiChatOptions {
  signal?: AbortSignal;
}

/**
 * One request only. No model fallback and no automatic retry are performed here.
 * The OpenAI-compatible Gemini endpoint exposes Gemini 3.x thinking through
 * `reasoning_effort`; `low` is the documented low-thinking mapping.
 */
export async function geminiChat(
  apiKey: string,
  body: Record<string, unknown>,
  options: GeminiChatOptions = {},
): Promise<unknown> {
  const res = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...body,
      model: GEMINI_MODEL,
      reasoning_effort: "low",
    }),
    signal: options.signal,
  });

  if (res.ok) return await res.json();

  const text = await res.text().catch(() => "");
  throw new GeminiError(res.status, text.slice(0, 300));
}
