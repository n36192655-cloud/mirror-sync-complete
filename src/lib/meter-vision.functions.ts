import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * قراءة عداد المياه من الصورة باستخدام نموذج رؤية (AI OCR).
 * لا يحفظ شيئاً ولا يغيّر أي منطق حسابي — يعيد اقتراحاً فقط ليؤكده المستخدم.
 */
export interface MeterVisionResult {
  /** القراءة الحالية المستخرجة من خانات العداد */
  readingValue: number | null;
  /** ثقة النموذج 0-100 */
  confidence: number;
  /** رقم العداد كما ظهر على جسم العداد (تحقق فقط) */
  meterNumber: string | null;
  /** أرقام أخرى ظهرت في الصورة (للعرض فقط) */
  otherNumbers: string[];
  /** لا يمكن الحسم — يُطلب إدخال يدوي */
  ambiguous: boolean;
}

interface VisionInput {
  imageDataUrl: string;
  knownMeterNumber?: string;
  previousReading?: number | null;
}

function validate(input: unknown): VisionInput {
  const obj = (input ?? {}) as Record<string, unknown>;
  const imageDataUrl = typeof obj["imageDataUrl"] === "string" ? obj["imageDataUrl"] : "";
  if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(imageDataUrl)) {
    throw new Error("صورة غير صالحة");
  }
  // حد أقصى ~6MB بعد base64
  if (imageDataUrl.length > 8_000_000) throw new Error("حجم الصورة كبير جداً");
  const knownMeterNumber =
    typeof obj["knownMeterNumber"] === "string" ? obj["knownMeterNumber"].slice(0, 40) : undefined;
  const prev = obj["previousReading"];
  const previousReading = typeof prev === "number" && Number.isFinite(prev) ? prev : null;
  return { imageDataUrl, knownMeterNumber, previousReading };
}

export const readMeterFromImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validate)
  .handler(async ({ data }): Promise<MeterVisionResult> => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("خدمة الذكاء الاصطناعي غير مهيأة (LOVABLE_API_KEY مفقود).");

    const hints = [
      data.knownMeterNumber ? `رقم العداد المعروف مسبقاً: ${data.knownMeterNumber}` : null,
      data.previousReading != null ? `القراءة السابقة المسجلة: ${data.previousReading}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const system = `أنت خبير في قراءة عدادات المياه من الصور.
مهمتك: استخراج «القراءة الحالية» الظاهرة في خانات العدّاد (العدّاد الميكانيكي أو الشاشة الرقمية) فقط.
قواعد صارمة:
1. القراءة الحالية هي الأرقام الكبيرة داخل خانات العدّاد، وقد تشمل خانات حمراء (كسور) — تجاهل الخانات الحمراء/الكسرية إن كانت منفصلة واستخرج الجزء الصحيح.
2. لا تخلط بين القراءة ورقم العداد التسلسلي المطبوع على الجسم أو الملصق.
3. تجاهل التواريخ وسنة الصنع والوحدات (m3) وأرقام الهاتف والعلامات التجارية والرموز الفنية.
4. إذا كانت الأرقام غير واضحة أو محتملة بأكثر من قراءة، اضبط ambiguous=true واترك readingValue=null. لا تخمّن أبداً.
5. أعد JSON فقط بلا أي شرح.`;

    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        readingValue: { type: ["number", "null"] },
        confidence: { type: "number" },
        meterNumber: { type: ["string", "null"] },
        otherNumbers: { type: "array", items: { type: "string" } },
        ambiguous: { type: "boolean" },
      },
      required: ["readingValue", "confidence", "meterNumber", "otherNumbers", "ambiguous"],
    };

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": apiKey,
        "X-Lovable-AIG-SDK": "fetch",
      },
      body: JSON.stringify({
        model: "google/gemini-3.7-flash",
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `اقرأ القراءة الحالية من صورة عداد المياه هذه.\n${hints}`,
              },
              { type: "image_url", image_url: { url: data.imageDataUrl } },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "meter_reading", strict: true, schema },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 429) throw new Error("الخدمة مزدحمة حالياً — أعد المحاولة بعد قليل");
      if (res.status === 402) throw new Error("رصيد الذكاء الاصطناعي غير كافٍ");
      throw new Error(`تعذر تحليل الصورة (${res.status}) ${body.slice(0, 160)}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
      }
    }

    const rawReading = parsed["readingValue"];
    const readingValue =
      typeof rawReading === "number" && Number.isFinite(rawReading) && rawReading >= 0
        ? rawReading
        : null;
    const rawConf = parsed["confidence"];
    const confidence =
      typeof rawConf === "number" && Number.isFinite(rawConf)
        ? Math.max(0, Math.min(100, Math.round(rawConf <= 1 ? rawConf * 100 : rawConf)))
        : 0;

    return {
      readingValue,
      confidence,
      meterNumber: typeof parsed["meterNumber"] === "string" ? parsed["meterNumber"] : null,
      otherNumbers: Array.isArray(parsed["otherNumbers"])
        ? parsed["otherNumbers"].map((v) => String(v)).slice(0, 8)
        : [],
      ambiguous: parsed["ambiguous"] === true,
    };
  });
