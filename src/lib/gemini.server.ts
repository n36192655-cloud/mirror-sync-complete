/**
 * اتصال Gemini المشترك (الشات + OCR).
 * قائمة النماذج مرتبة حسب الاستقرار والسرعة، مع fallback عند فشل نموذج.
 */
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

/** Stable Gemini 3 models; avoid retired 2.x IDs in production. */
const GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
];

export class GeminiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * ينفّذ طلب chat/completions مع تبديل تلقائي للنموذج عند الفشل القابل للتعافي.
 * body يُمرَّر كما هو (مع إضافة model فقط).
 */
export async function geminiChat(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  let last: GeminiError | null = null;

  for (const model of GEMINI_MODELS) {
    const res = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...body, model }),
    });

    if (res.ok) return await res.json();

    const text = await res.text().catch(() => "");
    last = new GeminiError(res.status, text.slice(0, 300));
    console.error("[gemini] model failed", model, res.status, text.slice(0, 300));

    // 429/404/5xx are recoverable at the model-selection layer.
    // Do not retry authentication/permission failures: another model will not fix a bad key.
    const retryable = res.status === 429 || res.status === 404 || res.status >= 500;
    if (!retryable) break;
  }

  throw last ?? new GeminiError(500, "تعذّر الوصول إلى محرك الذكاء الاصطناعي.");
}
