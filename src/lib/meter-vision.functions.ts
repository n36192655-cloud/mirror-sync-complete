import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface MeterVisionResult {
  readingValue: number | null;
  confidence: number;
  meterNumber: string | null;
  otherNumbers: string[];
  ambiguous: boolean;
  serialMatch: "match" | "mismatch" | "unknown";
}

interface VisionInput {
  imageDataUrl: string;
  knownMeterNumber?: string;
  previousReading?: number | null;
}

function validate(input: unknown): VisionInput {
  const obj = (input ?? {}) as Record<string, unknown>;
  const imageDataUrl = typeof obj.imageDataUrl === "string" ? obj.imageDataUrl : "";
  if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(imageDataUrl)) {
    throw new Error("صورة غير صالحة");
  }
  if (imageDataUrl.length > 8_000_000) throw new Error("حجم الصورة كبير جداً");
  const knownMeterNumber =
    typeof obj.knownMeterNumber === "string"
      ? obj.knownMeterNumber.trim().slice(0, 40)
      : undefined;
  const previousReading =
    typeof obj.previousReading === "number" && Number.isFinite(obj.previousReading)
      ? obj.previousReading
      : null;
  return { imageDataUrl, knownMeterNumber, previousReading };
}

function canonicalMeterNumber(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function exactSerialMatch(
  knownMeterNumber: string | undefined,
  candidates: Array<string | null | undefined>,
): "match" | "mismatch" | "unknown" {
  const known = canonicalMeterNumber(knownMeterNumber ?? "");
  if (!known) return "unknown";
  const values = candidates
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .map(canonicalMeterNumber)
    .filter(Boolean);
  // Fail closed: with a linked meter, unreadable identity is not acceptable for a reading.
  if (values.length === 0) return "mismatch";
  return values.includes(known) ? "match" : "mismatch";
}

export const readMeterFromImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validate)
  .handler(async ({ data }): Promise<MeterVisionResult> => {
    const apiKey = process.env["GEMINI_API_KEY"];
    if (!apiKey) {
      throw new Error("خدمة الذكاء الاصطناعي غير مهيأة (GEMINI_API_KEY مفقود).");
    }

    const hints = [
      data.knownMeterNumber ? `رقم العداد المتوقع: ${data.knownMeterNumber}` : null,
      data.previousReading != null ? `القراءة السابقة: ${data.previousReading}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    const system = `أنت نظام رؤية متخصص في عدادات المياه.

المطلوب مهمتان مستقلتان:
1) التعرف على الرقم التسلسلي للعداد نفسه للتحقق من الهوية.
2) قراءة خانات الاستهلاك داخل نافذة القراءة فقط.

قواعد رقم العداد:
- اقرأ الرقم التسلسلي كما هو مطبوع على جسم العداد أو الملصق المرتبط به.
- لا تعتبر رقم القراءة أو السنة أو التاريخ أو DN/Q3/R160 أو أي رقم تقني رقماً للعداد.
- لا تخمّن أي خانة.
- إذا لم يكن الرقم التسلسلي واضحاً بالكامل، meterNumber يجب أن يكون نصاً فارغاً.
- لا تضف أو تحذف أصفاراً ولا تصحح حرفاً مشكوكاً فيه من نفسك.

قواعد القراءة:
- مصدر القراءة الوحيد هو نافذة خانات الاستهلاك.
- تجاهل الرقم التسلسلي وكل الأرقام خارج نافذة القراءة.
- اقرأ الخانات من اليسار إلى اليمين، مع الحفاظ على الأصفار في البداية.
- استبعد الخانات الكسرية الحمراء/العشرية إذا كانت ظاهرة، حسب إعداد العداد المعتاد.
- إذا كانت خانة ميكانيكية بين رقمين ولا يمكن حسمها، اعتبر النتيجة ambiguous.
- إذا كانت الصورة ضبابية أو مظلمة أو فيها انعكاس/حجب يمنع قراءة خانة، لا تخمّن.
- readingDigits يجب أن يكون النص الدقيق للخانات الصحيحة فقط، أو فارغاً عند عدم القدرة على الحسم.
- confidence بين 0 و100 ويعبّر عن وضوح القراءة فعلياً، وليس عن احتمال التخمين.
- أعد JSON فقط.`;

    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        readingDigits: { type: "string" },
        confidence: { type: "number" },
        meterNumber: { type: "string" },
        otherNumbers: { type: "array", items: { type: "string" } },
        ambiguous: { type: "boolean" },
      },
      required: [
        "readingDigits",
        "confidence",
        "meterNumber",
        "otherNumbers",
        "ambiguous",
      ],
    };

    interface Pass {
      readingValue: number | null;
      readingDigits: string;
      confidence: number;
      meterNumber: string | null;
      otherNumbers: string[];
      ambiguous: boolean;
      serialMatch: "match" | "mismatch" | "unknown";
    }

    async function runPass(): Promise<Pass> {
      const { geminiChat, GeminiError } = await import("./gemini.server");
      let response: {
        choices?: Array<{ message?: { content?: string } }>;
      };
      try {
        response = (await geminiChat(apiKey, {
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `حلّل صورة عداد المياه. تحقق من هوية العداد أولاً، ثم اقرأ خانات الاستهلاك فقط.\n${hints}`,
                },
                {
                  type: "image_url",
                  image_url: { url: data.imageDataUrl },
                },
              ],
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "meter_reading", schema },
          },
        })) as typeof response;
      } catch (error) {
        const status = error instanceof GeminiError ? error.status : 0;
        if (status === 429) {
          throw new Error("الخدمة مزدحمة حالياً — أعد المحاولة بعد قليل");
        }
        if (status === 402) throw new Error("رصيد الذكاء الاصطناعي غير كافٍ");
        throw new Error(`تعذر تحليل الصورة (${status})`);
      }

      const content = response.choices?.[0]?.message?.content ?? "";
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(content) as Record<string, unknown>;
      } catch {
        const match = content.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            parsed = JSON.parse(match[0]) as Record<string, unknown>;
          } catch {
            parsed = {};
          }
        }
      }

      const readingDigits =
        typeof parsed.readingDigits === "string" ? parsed.readingDigits.trim() : "";
      const digitOnly = readingDigits.replace(/[^0-9]/g, "");
      const compactDigits = readingDigits.replace(/\s/g, "");
      const readingValue =
        digitOnly.length >= 1 &&
        digitOnly.length <= 12 &&
        digitOnly.length === compactDigits.length
          ? Number(digitOnly)
          : null;
      const rawConfidence = parsed.confidence;
      const confidence =
        typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
          ? Math.max(
              0,
              Math.min(100, Math.round(rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence)),
            )
          : 0;
      const meterNumber =
        typeof parsed.meterNumber === "string" && parsed.meterNumber.trim()
          ? parsed.meterNumber.trim()
          : null;
      const otherNumbers = Array.isArray(parsed.otherNumbers)
        ? parsed.otherNumbers.map(String).filter(Boolean).slice(0, 12)
        : [];
      const serialMatch = exactSerialMatch(data.knownMeterNumber, [
        meterNumber,
        ...otherNumbers,
      ]);
      return {
        readingValue,
        readingDigits,
        confidence,
        meterNumber,
        otherNumbers,
        ambiguous: parsed.ambiguous === true || readingValue == null,
        serialMatch,
      };
    }

    if (!canonicalMeterNumber(data.knownMeterNumber ?? "")) {
      return {
        readingValue: null,
        confidence: 0,
        meterNumber: null,
        otherNumbers: [],
        ambiguous: true,
        serialMatch: "unknown",
      };
    }

    const first = await runPass();
    const firstBelowPrevious =
      data.previousReading != null &&
      first.readingValue != null &&
      first.readingValue < data.previousReading;
    const firstAcceptable =
      first.serialMatch === "match" &&
      first.readingValue != null &&
      !first.ambiguous &&
      first.confidence >= 85 &&
      !firstBelowPrevious;

    if (!firstAcceptable) {
      let second: Pass;
      try {
        second = await runPass();
      } catch {
        return {
          ...first,
          readingValue: null,
          ambiguous: true,
          serialMatch: first.serialMatch,
        };
      }
      const secondBelowPrevious =
        data.previousReading != null &&
        second.readingValue != null &&
        second.readingValue < data.previousReading;
      const sameSerial =
        first.serialMatch === "match" && second.serialMatch === "match";
      const sameReading =
        first.readingValue != null &&
        second.readingValue != null &&
        first.readingValue === second.readingValue;
      if (
        !sameSerial ||
        !sameReading ||
        second.readingValue == null ||
        second.ambiguous ||
        second.confidence < 85 ||
        secondBelowPrevious
      ) {
        const serialMatch =
          first.serialMatch === "mismatch" || second.serialMatch === "mismatch"
            ? "mismatch"
            : "unknown";
        return {
          ...second,
          readingValue: null,
          ambiguous: true,
          serialMatch,
        };
      }
      return {
        ...second,
        confidence: Math.min(100, Math.max(first.confidence, second.confidence, 95)),
        ambiguous: false,
        serialMatch: "match",
      };
    }
    return first;
  });
