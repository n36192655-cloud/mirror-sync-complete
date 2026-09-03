import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { normalizeMeterDisplayType, parseMeterReading, type MeterDisplayType } from "./meter-display";
import { normalizeMeterTechnologyType, requiresStrongVisionEvidence, type MeterTechnologyType } from "./meter-technology";
import { validateDisplayReading } from "./meter-display-decision";

export interface MeterVisionResult {
  readingValue: number | null;
  confidence: number;
  meterNumber: string | null;
  otherNumbers: string[];
  ambiguous: boolean;
  serialMatch: "match" | "mismatch" | "unknown";
  displayType: MeterDisplayType;
  technologyType: MeterTechnologyType;
}

interface VisionInput { imageDataUrl: string; knownMeterNumber?: string; previousReading?: number | null; }
function validate(input: unknown): VisionInput {
  const obj = (input ?? {}) as Record<string, unknown>;
  const imageDataUrl = typeof obj.imageDataUrl === "string" ? obj.imageDataUrl : "";
  if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(imageDataUrl)) throw new Error("صورة غير صالحة");
  if (imageDataUrl.length > 8_000_000) throw new Error("حجم الصورة كبير جداً");
  const knownMeterNumber = typeof obj.knownMeterNumber === "string" ? obj.knownMeterNumber.trim().slice(0, 40) : undefined;
  const previousReading = typeof obj.previousReading === "number" && Number.isFinite(obj.previousReading) ? obj.previousReading : null;
  return { imageDataUrl, knownMeterNumber, previousReading };
}

const DIGIT_RANGES: Array<[number, number]> = [
  [0x0660, 0x0669], [0x06f0, 0x06f9], [0x0966, 0x096f], [0x09e6, 0x09ef],
  [0x0ae6, 0x0aef], [0x0a66, 0x0a6f], [0x0be6, 0x0bef], [0x0c66, 0x0c6f],
  [0x0ce6, 0x0cef], [0x0d66, 0x0d6f], [0x0b66, 0x0b6f],
];
const DIGIT_RE = /[٠-٩۰-۹०-९০-৯૦-૯੦-੯௦-௯౦-౯೦-೯൦-൯୦-୯]/g;
function normalizeDigits(value: string): string {
  return value.replace(DIGIT_RE, (digit) => {
    const code = digit.charCodeAt(0);
    for (const [start, end] of DIGIT_RANGES) if (code >= start && code <= end) return String(code - start);
    return digit;
  });
}
function canonicalMeterNumber(value: string): string { return normalizeDigits(value).normalize("NFKC").trim().toUpperCase().replace(/[\u2010-\u2015\u2212]/g, "-").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, ""); }
function exactSerialMatch(knownMeterNumber: string | undefined, candidates: Array<string | null | undefined>): "match" | "mismatch" | "unknown" {
  const known = canonicalMeterNumber(knownMeterNumber ?? "");
  if (!known) return "unknown";
  const values = candidates.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map(canonicalMeterNumber).filter(Boolean);
  if (values.length === 0) return "mismatch";
  return values.includes(known) ? "match" : "mismatch";
}

export const readMeterFromImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validate)
  .handler(async ({ data }): Promise<MeterVisionResult> => {
    const apiKey: string = process.env["GEMINI_API_KEY"] ?? "";
    if (!apiKey) throw new Error("خدمة الذكاء الاصطناعي غير مهيأة (GEMINI_API_KEY مفقود).");
    const hints = [data.knownMeterNumber ? `رقم العداد المتوقع: ${data.knownMeterNumber}` : null, data.previousReading != null ? `القراءة السابقة: ${data.previousReading}` : null].filter(Boolean).join("\n");
    const system = `أنت نظام رؤية متخصص في قراءة جميع أنواع عدادات المياه الواقعية، بما فيها العدادات الشائعة في اليمن.
قبل القراءة صنّف العداد إلى technologyType من: mechanical_multi_jet, mechanical_single_jet, mechanical_positive_displacement, mechanical_propeller_bulk, prepaid_smart, ultrasonic, electromagnetic, smart_ami, unknown.
وصنّف العرض إلى displayType من: mechanical_roller, digital_lcd, digital_led, black_red_register, multi_register, analog_dial, smart_display, unknown.
نفّذ مهمتين مستقلتين لكن مترابطتين: إثبات هوية العداد من الرقم التسلسلي المطبوع، ثم استخراج قراءة الاستهلاك من آلية العرض.
قواعد الهوية: الرقم التسلسلي هو الرقم المطبوع على جسم العداد أو الملصق المرتبط به. لا تعتبر رقم القراءة أو السنة أو التاريخ أو DN/Q3/R160 أو أي رقم تقني رقماً للعداد. لا تخمّن أي خانة. إذا لم يكن الرقم التسلسلي واضحاً بالكامل فاجعل meterNumber فارغاً. لا تضف أو تحذف أصفاراً ولا تصحح حرفاً مشكوكاً فيه.
قواعد القراءة: اقرأ خانات الاستهلاك من اليسار إلى اليمين كما تظهر. لا تخلط الرقم التسلسلي أو الأرقام التقنية مع القراءة. حافظ على الخانات الصحيحة كاملة. إذا كان أي رقم غير محسوم بسبب الضبابية أو الانعكاس أو الحجب فاجعل ambiguous=true وreadingDigits فارغاً. يجب أن تمثل readingDigits القراءة النهائية فقط. confidence من 0 إلى 100 ويعبّر عن وضوح الدليل المرئي، وليس عن التخمين. للعداد analog_dial أو multi_register أو smart_display أو التقنيات الإلكترونية/الذكية، كن محافظاً جداً: إذا لم تكن كل الخانات/المؤشرات المطلوبة واضحة فلا تخمّن. لا تجعل القراءة أقل من السابقة عند وجودها. أعد JSON فقط.`;
    const schema = { type: "object", additionalProperties: false, properties: { readingDigits: { type: "string" }, confidence: { type: "number" }, meterNumber: { type: "string" }, otherNumbers: { type: "array", items: { type: "string" } }, ambiguous: { type: "boolean" }, displayType: { type: "string" }, technologyType: { type: "string" } }, required: ["readingDigits", "confidence", "meterNumber", "otherNumbers", "ambiguous", "displayType", "technologyType"] };
    if (!canonicalMeterNumber(data.knownMeterNumber ?? "")) return { readingValue: null, confidence: 0, meterNumber: null, otherNumbers: [], ambiguous: true, serialMatch: "unknown", displayType: "unknown", technologyType: "unknown" };

    const { geminiChat, GeminiError } = await import("./gemini.server");
    let response: { choices?: Array<{ message?: { content?: string } }> };
    try {
      response = (await Promise.race([
        geminiChat(apiKey, { messages: [{ role: "system", content: system }, { role: "user", content: [{ type: "text", text: `حلّل صورة عداد المياه. صنّف التقنية ونوع العرض، ثم أثبت هوية العداد، ثم استخرج قراءة الاستهلاك فقط.\n${hints}` }, { type: "image_url", image_url: { url: data.imageDataUrl } }] }], response_format: { type: "json_schema", json_schema: { name: "meter_reading", schema } } }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("AI_TIMEOUT")), 3000)),
      ])) as typeof response;
    } catch (error) {
      const status = error instanceof GeminiError ? error.status : 0;
      if (error instanceof Error && error.message === "AI_TIMEOUT") throw new Error("انتهت مهلة تحليل صورة العداد؛ أعد التصوير بصورة أوضح.");
      if (status === 429) throw new Error("الخدمة مزدحمة حالياً — أعد المحاولة بعد قليل");
      if (status === 402) throw new Error("رصيد الذكاء الاصطناعي غير كافٍ");
      throw new Error(`تعذر تحليل الصورة (${status})`);
    }

    const content = response.choices?.[0]?.message?.content ?? "";
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(content) as Record<string, unknown>; } catch { const match = content.match(/\{[\s\S]*\}/); if (match) { try { parsed = JSON.parse(match[0]) as Record<string, unknown>; } catch { parsed = {}; } } }
    const readingDigits = typeof parsed.readingDigits === "string" ? parsed.readingDigits.trim() : "";
    const normalizedReading = normalizeDigits(readingDigits).replace(/[٫﹒．]/g, ".");
    const parsedReading = parseMeterReading(normalizedReading);
    const readingValue = parsedReading.valid ? parsedReading.value : null;
    const rawConfidence = parsed.confidence;
    const confidence = typeof rawConfidence === "number" && Number.isFinite(rawConfidence) ? Math.max(0, Math.min(100, Math.round(rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence))) : 0;
    const meterNumber = typeof parsed.meterNumber === "string" && parsed.meterNumber.trim() ? parsed.meterNumber.trim() : null;
    const otherNumbers = Array.isArray(parsed.otherNumbers) ? parsed.otherNumbers.map(String).filter(Boolean).slice(0, 12) : [];
    const serialMatch = exactSerialMatch(data.knownMeterNumber, [meterNumber, ...otherNumbers]);
    const displayType = normalizeMeterDisplayType(parsed.displayType);
    const technologyType = normalizeMeterTechnologyType(parsed.technologyType);
    const belowPrevious = data.previousReading != null && readingValue != null && readingValue < data.previousReading;
    const displayDecision = validateDisplayReading(displayType, parsedReading.normalized, confidence);
    const strongEvidenceRequired = requiresStrongVisionEvidence(technologyType, displayType);
    const confidenceThreshold = strongEvidenceRequired ? 92 : 85;
    const ambiguous = parsed.ambiguous === true
      || displayDecision.ambiguous
      || readingValue == null
      || belowPrevious
      || confidence < confidenceThreshold
      || serialMatch !== "match";
    return { readingValue: ambiguous ? null : readingValue, confidence, meterNumber, otherNumbers, ambiguous, serialMatch, displayType, technologyType };
  });
