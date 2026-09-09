import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  exactSerialMatch,
  saveManualFallbackMeterReading,
  saveVerifiedMeterReading,
  type MeterPipelineMetrics,
  type MeterVerificationResult,
  type VerifiedMeterReadingResult,
} from "./meter-vision.functions";
import { normalizeMeterReadingCandidate, type MeterReadingProfile } from "./meter-reading-profile";

export { readMeterFromImage } from "./meter-vision.functions";
export { saveManualFallbackMeterReading, saveVerifiedMeterReading };
export type { MeterPipelineMetrics, MeterVerificationResult, VerifiedMeterReadingResult };

interface VerificationInput { imageDataUrl: string; originalImageDataUrl: string; meterId: string; customerId: string; readingDate: string; clientUuid: string; attemptCount: number; }
const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
function validate(input: unknown): VerificationInput {
  const obj = (input ?? {}) as Record<string, unknown>;
  const imageDataUrl = typeof obj.imageDataUrl === "string" ? obj.imageDataUrl : "";
  const originalImageDataUrl = typeof obj.originalImageDataUrl === "string" ? obj.originalImageDataUrl : "";
  const meterId = typeof obj.meterId === "string" ? obj.meterId.trim() : "";
  const customerId = typeof obj.customerId === "string" ? obj.customerId.trim() : "";
  const readingDate = typeof obj.readingDate === "string" ? obj.readingDate.trim() : "";
  const clientUuid = typeof obj.clientUuid === "string" ? obj.clientUuid.trim() : "";
  const attemptCount = typeof obj.attemptCount === "number" && Number.isSafeInteger(obj.attemptCount) ? obj.attemptCount : 1;
  if (!DATA_URL_RE.test(imageDataUrl) || imageDataUrl.length > 8_000_000) throw new Error("صورة التحليل غير صالحة");
  if (!DATA_URL_RE.test(originalImageDataUrl) || originalImageDataUrl.length > 34_000_000) throw new Error("الصورة الأصلية غير صالحة");
  if (!meterId || !customerId || !/^\d{4}-\d{2}-\d{2}$/.test(readingDate) || !UUID_RE.test(clientUuid)) throw new Error("بيانات دورة القراءة غير صالحة");
  if (attemptCount < 1) throw new Error("عدد محاولات OCR غير صالح");
  return { imageDataUrl, originalImageDataUrl, meterId, customerId, readingDate, clientUuid, attemptCount };
}
function b64url(bytes: ArrayBuffer | Uint8Array): string { const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); let binary = ""; for (const byte of value) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
async function proofKey(apiKey: string): Promise<CryptoKey> { return crypto.subtle.importKey("raw", encoder.encode(`MIZAN-METER-PROOF-v2:${apiKey}`).buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); }
async function signProof(payload: string, apiKey: string): Promise<string> { const signature = await crypto.subtle.sign("HMAC", await proofKey(apiKey), encoder.encode(payload).buffer); return `${b64url(encoder.encode(payload))}.${b64url(signature)}`; }
async function sha256(bytes: Uint8Array): Promise<string> { const copy = new ArrayBuffer(bytes.byteLength); new Uint8Array(copy).set(bytes); return b64url(await crypto.subtle.digest("SHA-256", copy)); }
function decodeImageDataUrl(dataUrl: string): Uint8Array { const match = dataUrl.match(/^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/); if (!match) throw new Error("الصورة الأصلية غير صالحة"); const binary = atob(match[1]); const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0)); if (bytes.length > 25 * 1024 * 1024) throw new Error("حجم الصورة أكبر من الحد المسموح"); return bytes; }
function profileFromRow(row: Record<string, unknown>): MeterReadingProfile { const displayType = typeof row.display_type === "string" ? row.display_type : null; const integerDigits = typeof row.integer_digits === "number" ? row.integer_digits : null; const decimalDigits = typeof row.decimal_digits === "number" ? row.decimal_digits : null; const decimalSeparator = row.decimal_separator === "." || row.decimal_separator === "," ? row.decimal_separator : null; const registerSemantics = row.register_semantics && typeof row.register_semantics === "object" && !Array.isArray(row.register_semantics) ? row.register_semantics as Record<string, unknown> : null; return { displayType: displayType as MeterReadingProfile["displayType"], integerDigits, decimalDigits, decimalSeparator, registerSemantics }; }
async function loadAuthoritativeContext(context: { supabase: SupabaseClient; userId: string }, data: VerificationInput) {
  const { data: profile } = await context.supabase.from("profiles").select("tenant_id").eq("id", context.userId).maybeSingle();
  if (!profile?.tenant_id) throw new Error("تعذر تحديد المؤسسة للمستخدم الحالي"); const tenantId = profile.tenant_id;
  const meterQuery = context.supabase as SupabaseClient;
  const { data: meter } = await meterQuery.from("meters").select("id, serial, tenant_id, display_type, integer_digits, decimal_digits, decimal_separator, register_semantics").eq("id", data.meterId).maybeSingle();
  if (!meter || meter.tenant_id !== tenantId) throw new Error("العداد غير موجود أو غير تابع للمؤسسة الحالية");
  const { data: customer } = await context.supabase.from("customers").select("id, tenant_id").eq("id", data.customerId).maybeSingle();
  if (!customer || customer.tenant_id !== tenantId) throw new Error("المشترك غير موجود أو غير تابع للمؤسسة الحالية");
  const { data: assignment } = await context.supabase.from("meter_assignments").select("customer_id, meter_id, started_at, ended_at").eq("tenant_id", tenantId).eq("customer_id", data.customerId).eq("meter_id", data.meterId).lte("started_at", `${data.readingDate}T23:59:59.999Z`).or(`ended_at.is.null,ended_at.gte.${data.readingDate}T00:00:00.000Z`).order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (!assignment) throw new Error("العداد غير مرتبط بالمشترك في تاريخ القراءة");
  const { data: previousRow } = await context.supabase.from("water_readings").select("current_reading").eq("tenant_id", tenantId).eq("meter_id", data.meterId).eq("status", "approved").lte("reading_date", data.readingDate).order("reading_date", { ascending: false }).order("created_at", { ascending: false }).limit(1).maybeSingle();
  return { tenantId, meter, profile: profileFromRow(meter as Record<string, unknown>), previousReading: previousRow?.current_reading ?? 0 };
}
function parseVisionResponse(response: unknown, expectedMeterNumber: string, previousReading: number, profile: MeterReadingProfile) {
  const content = (response as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? ""; let parsed: Record<string, unknown>; try { parsed = JSON.parse(content) as Record<string, unknown>; } catch { throw new Error("استجابة الرؤية ليست JSON صالحاً"); }
  const rawReading = typeof parsed.readingDigits === "string" ? parsed.readingDigits : ""; const candidate = normalizeMeterReadingCandidate(rawReading, profile); const readingValue = candidate?.value ?? null;
  const rawConfidence = parsed.confidence; const confidence = typeof rawConfidence === "number" && Number.isFinite(rawConfidence) ? Math.max(0, Math.min(100, Math.round(rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence))) : 0;
  const meterNumber = typeof parsed.meterNumber === "string" && parsed.meterNumber.trim() ? parsed.meterNumber.trim() : null; const otherNumbers = Array.isArray(parsed.otherNumbers) ? parsed.otherNumbers.map(String).filter(Boolean).slice(0, 12) : [];
  const serialMatch: "match" | "mismatch" | "unknown" = !meterNumber ? "unknown" : exactSerialMatch(expectedMeterNumber, meterNumber) ? "match" : "mismatch"; const belowPrevious = readingValue != null && readingValue < previousReading; const ambiguous = parsed.ambiguous === true || readingValue == null || belowPrevious || confidence < 85 || serialMatch === "mismatch";
  return { readingValue: ambiguous ? null : readingValue, confidence, meterNumber, otherNumbers, ambiguous, serialMatch };
}
async function runInference(apiKey: string, data: VerificationInput, expectedMeterNumber: string, previousReading: number, profile: MeterReadingProfile) {
  const { geminiChat, GeminiError } = await import("./gemini.server");
  const system = `أنت نظام رؤية متخصص في قراءة عدادات المياه من الصور الواقعية. استخرج فقط البيانات المرئية ولا تخمّن. اقرأ الرقم التسلسلي المطبوع على جسم العداد أو الملصق المرتبط به. لا تعتبر رقم القراءة أو السنة أو التاريخ أو DN/Q3/R160 أو أي رقم تقني رقماً للعداد. إذا لم يكن الرقم التسلسلي واضحاً بالكامل اجعل meterNumber فارغاً. لا تضف أو تحذف أصفاراً ولا تصحح حرفاً مشكوكاً فيه. اقرأ خانات الاستهلاك فقط. إذا كانت أي خانة غير محسومة بسبب الضبابية أو الانعكاس أو الحجب اجعل ambiguous=true وreadingDigits فارغاً. confidence يصف وضوح الدليل المرئي ولا يثبت الهوية. أعد readingDigits كسلسلة كما تظهر بصرياً، مع الفاصل العشري المرئي، ولا تقرب أو تقطع الخانات.`;
  const schema = { type: "object", additionalProperties: false, properties: { readingDigits: { type: "string" }, confidence: { type: "number" }, meterNumber: { type: "string" }, otherNumbers: { type: "array", items: { type: "string" } }, ambiguous: { type: "boolean" } }, required: ["readingDigits", "confidence", "meterNumber", "otherNumbers", "ambiguous"] };
  const started = performance.now();
  try {
    const response = await geminiChat(apiKey, { messages: [
      { role: "system", content: system },
      { role: "user", content: [
        { type: "text", text: `الرقم المتوقع يستخدم للمقارنة الدقيقة فقط. القراءة السابقة: ${previousReading}. إعداد العداد: ${JSON.stringify({ displayType: profile.displayType, integerDigits: profile.integerDigits, decimalDigits: profile.decimalDigits, decimalSeparator: profile.decimalSeparator, registerSemantics: profile.registerSemantics })}. لا تستنتج معنى اللون من نفسك ولا تستخدم الرقم المتوقع كبديل عن الرقم المرئي.` },
        { type: "image_url", image_url: { url: data.imageDataUrl } },
      ] },
    ], response_format: { type: "json_schema", json_schema: { name: "meter_reading", schema } } });
    const result = parseVisionResponse(response, expectedMeterNumber, previousReading, profile); const metrics: MeterPipelineMetrics = { imagePreparationMs: 0, aiInferenceMs: performance.now() - started, parseMs: 0, identityValidationMs: 0, totalServerMs: performance.now() - started }; return { result, metrics };
  } catch (error) { if (error instanceof GeminiError) throw new Error(`تعذر تحليل الصورة (${error.status})`); throw error; }
}
export const verifyMeterImage = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator(validate).handler(async ({ data, context }): Promise<MeterVerificationResult> => {
  const apiKey = process.env["GEMINI_API_KEY"] ?? ""; if (!apiKey) throw new Error("GEMINI_API_KEY مفقود"); const originalBytes = decodeImageDataUrl(data.originalImageDataUrl); const imageHash = await sha256(originalBytes); const auth = await loadAuthoritativeContext(context, data); const { result, metrics } = await runInference(apiKey, data, auth.meter.serial, auth.previousReading, auth.profile); if (result.serialMatch === "mismatch") throw new Error("رفض: هوية العداد الظاهرة في الصورة لا تطابق العداد المرتبط"); if (result.ambiguous || result.readingValue == null) throw new Error("رفض القراءة: تعذر استخراج قراءة واضحة أو لم تسمح إعدادات العداد بتحديد الدقة");
  const payload = JSON.stringify({ v: "2", userId: context.userId, tenantId: auth.tenantId, customerId: data.customerId, meterId: data.meterId, readingDate: data.readingDate, clientUuid: data.clientUuid, meterNumber: auth.meter.serial, readingValue: String(result.readingValue), serialMatch: result.serialMatch, imageHash, attemptCount: data.attemptCount, exp: Date.now() + 10 * 60 * 1000 }); return { ...result, verificationToken: await signProof(payload, apiKey), metrics };
});
