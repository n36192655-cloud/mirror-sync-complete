import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

export interface MeterVisionResult {
  readingValue: number | null;
  confidence: number;
  meterNumber: string | null;
  otherNumbers: string[];
  ambiguous: boolean;
  serialMatch: "match" | "mismatch" | "unknown";
}

export interface VerifiedMeterReadingResult extends MeterVisionResult {
  saved: boolean;
  readingId: string | null;
  evidencePath: string | null;
}

interface VisionInput {
  imageDataUrl: string;
  knownMeterNumber?: string;
  previousReading?: number | null;
}

function validate(input: unknown): VisionInput {
  const obj = (input ?? {}) as Record<string, unknown>;
  const imageDataUrl = typeof obj.imageDataUrl === "string" ? obj.imageDataUrl : "";
  if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(imageDataUrl)) throw new Error("صورة غير صالحة");
  if (imageDataUrl.length > 8_000_000) throw new Error("حجم الصورة كبير جداً");
  const knownMeterNumber = typeof obj.knownMeterNumber === "string" ? obj.knownMeterNumber.trim().slice(0, 80) : undefined;
  const previousReading = typeof obj.previousReading === "number" && Number.isFinite(obj.previousReading) ? obj.previousReading : null;
  return { imageDataUrl, knownMeterNumber, previousReading };
}

interface SaveInput extends VisionInput {
  customerId: string;
  meterId: string;
  readingDate: string;
  clientUuid: string;
  latitude?: number | null;
  longitude?: number | null;
  gpsVerified?: boolean;
}

function validateSave(input: unknown): SaveInput {
  const base = validate(input);
  const obj = (input ?? {}) as Record<string, unknown>;
  const uuid = typeof obj.clientUuid === "string" ? obj.clientUuid.trim() : "";
  const customerId = typeof obj.customerId === "string" ? obj.customerId.trim() : "";
  const meterId = typeof obj.meterId === "string" ? obj.meterId.trim() : "";
  const readingDate = typeof obj.readingDate === "string" ? obj.readingDate.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) throw new Error("client_uuid غير صالح");
  if (!customerId || !meterId || !/^\d{4}-\d{2}-\d{2}$/.test(readingDate)) throw new Error("بيانات القراءة غير مكتملة");
  return {
    ...base,
    customerId,
    meterId,
    readingDate,
    clientUuid: uuid,
    latitude: typeof obj.latitude === "number" && Number.isFinite(obj.latitude) ? obj.latitude : null,
    longitude: typeof obj.longitude === "number" && Number.isFinite(obj.longitude) ? obj.longitude : null,
    gpsVerified: obj.gpsVerified === true,
  };
}

function normalizeDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.charCodeAt(0);
    return code >= 0x0660 && code <= 0x0669 ? String(code - 0x0660) : String(code - 0x06f0);
  });
}

export function normalizeMeterIdentity(value: string): string {
  return normalizeDigits(value)
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function exactSerialMatch(expected: string | undefined, recognized: string | null | undefined): boolean {
  const left = normalizeMeterIdentity(expected ?? "");
  const right = normalizeMeterIdentity(recognized ?? "");
  return Boolean(left && right && left === right);
}

function parseVisionResponse(response: unknown, expectedMeterNumber: string, previousReading: number | null): MeterVisionResult {
  const content = (response as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? "";
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new Error("استجابة الرؤية ليست JSON صالحاً");
  }

  const readingDigits = typeof parsed.readingDigits === "string" ? normalizeDigits(parsed.readingDigits).replace(/\s/g, "").replace(/,/g, ".") : "";
  const validReadingShape = /^(?:\d{1,12}|\d{1,12}\.\d{1,3})$/.test(readingDigits);
  const readingValue = validReadingShape && Number.isFinite(Number(readingDigits)) ? Number(readingDigits) : null;
  const rawConfidence = parsed.confidence;
  const confidence = typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
    ? Math.max(0, Math.min(100, Math.round(rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence)))
    : 0;
  const meterNumber = typeof parsed.meterNumber === "string" && parsed.meterNumber.trim() ? parsed.meterNumber.trim() : null;
  const otherNumbers = Array.isArray(parsed.otherNumbers) ? parsed.otherNumbers.map(String).filter(Boolean).slice(0, 12) : [];
  const serialMatch = exactSerialMatch(expectedMeterNumber, meterNumber) ? "match" : "mismatch";
  const belowPrevious = previousReading != null && readingValue != null && readingValue < previousReading;
  const ambiguous = parsed.ambiguous === true || readingValue == null || belowPrevious || confidence < 85;
  return {
    readingValue: ambiguous ? null : readingValue,
    confidence,
    meterNumber,
    otherNumbers,
    ambiguous,
    serialMatch,
  };
}

async function runVisionInference(
  apiKey: string,
  imageDataUrl: string,
  expectedMeterNumber: string,
  previousReading: number | null,
  signal?: AbortSignal,
): Promise<MeterVisionResult> {
  const { geminiChat, GeminiError } = await import("./gemini.server");
  const system = `أنت نظام رؤية متخصص في قراءة عدادات المياه من الصور الواقعية.\nاستخرج فقط البيانات المرئية ولا تخمّن.\nهوية العداد: اقرأ الرقم التسلسلي المطبوع على جسم العداد أو الملصق المرتبط به. لا تعتبر رقم القراءة أو السنة أو التاريخ أو DN/Q3/R160 أو أي رقم تقني رقماً للعداد. إذا لم يكن الرقم التسلسلي واضحاً بالكامل، اجعل meterNumber فارغاً. لا تضف أو تحذف أصفاراً ولا تصحح حرفاً مشكوكاً فيه.\nالقراءة: اقرأ خانات الاستهلاك فقط من اليسار إلى اليمين. إذا كانت أي خانة غير محسومة بسبب الضبابية أو الانعكاس أو الحجب، اجعل ambiguous=true وreadingDigits فارغاً. confidence من 0 إلى 100 لوضوح الدليل المرئي وليس لإثبات الهوية.\nأعد JSON مطابقاً للمخطط فقط.`;
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
    required: ["readingDigits", "confidence", "meterNumber", "otherNumbers", "ambiguous"],
  };

  try {
    const response = await geminiChat(apiKey, {
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: `رقم العداد المتوقع موجود في قاعدة البيانات وسيستخدم للمطابقة الدقيقة. القراءة السابقة: ${previousReading ?? "غير متاحة"}. لا تستخدم الرقم المتوقع كبديل عن الرقم المرئي في الصورة.` },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
      response_format: { type: "json_schema", json_schema: { name: "meter_reading", schema } },
    }, { signal });
    return parseVisionResponse(response, expectedMeterNumber, previousReading);
  } catch (error) {
    if (error instanceof GeminiError) {
      if (error.status === 429) throw new Error("الخدمة مزدحمة حالياً — أعد المحاولة لاحقاً");
      if (error.status === 401 || error.status === 403) throw new Error("تعذر التحقق من خدمة الرؤية");
      throw new Error(`تعذر تحليل الصورة (${error.status})`);
    }
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw error;
  }
}

export const readMeterFromImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validate)
  .handler(async ({ data }): Promise<MeterVisionResult> => {
    const apiKey = process.env["GEMINI_API_KEY"] ?? "";
    if (!apiKey) throw new Error("خدمة الذكاء الاصطناعي غير مهيأة (GEMINI_API_KEY مفقود).");
    if (!data.knownMeterNumber) throw new Error("رقم العداد المتوقع مطلوب");
    return runVisionInference(apiKey, data.imageDataUrl, data.knownMeterNumber, data.previousReading ?? null);
  });

function decodeImageDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("صورة غير صالحة");
  const mime = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
  const binary = atob(match[2]);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytes.length > 25 * 1024 * 1024) throw new Error("حجم الصورة أكبر من الحد المسموح");
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const isWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if ((mime === "image/jpeg" && !isJpeg) || (mime === "image/png" && !isPng) || (mime === "image/webp" && !isWebp)) throw new Error("محتوى الصورة لا يطابق نوع الملف");
  return { bytes, mime };
}

export const saveVerifiedMeterReading = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validateSave)
  .handler(async ({ data, context }): Promise<VerifiedMeterReadingResult> => {
    const apiKey = process.env["GEMINI_API_KEY"] ?? "";
    if (!apiKey) throw new Error("خدمة الذكاء الاصطناعي غير مهيأة (GEMINI_API_KEY مفقود).");

    const { data: profile, error: profileError } = await context.supabase.from("profiles").select("tenant_id").eq("id", context.userId).maybeSingle();
    if (profileError || !profile?.tenant_id) throw new Error("تعذر تحديد المؤسسة للمستخدم الحالي");
    const tenantId = profile.tenant_id;

    const { data: meter, error: meterError } = await context.supabase.from("meters").select("id, serial, tenant_id").eq("id", data.meterId).maybeSingle();
    if (meterError || !meter || meter.tenant_id !== tenantId) throw new Error("العداد غير موجود أو غير تابع للمؤسسة الحالية");

    const { data: assignment, error: assignmentError } = await context.supabase.from("meter_assignments").select("customer_id, meter_id, started_at, ended_at").eq("tenant_id", tenantId).eq("customer_id", data.customerId).eq("meter_id", data.meterId).lte("started_at", `${data.readingDate}T23:59:59.999Z`).or(`ended_at.is.null,ended_at.gte.${data.readingDate}T00:00:00.000Z`).order("started_at", { ascending: false }).limit(1).maybeSingle();
    if (assignmentError || !assignment) throw new Error("العداد غير مرتبط بالمشترك في تاريخ القراءة");

    const { data: customer, error: customerError } = await context.supabase.from("customers").select("id, tenant_id").eq("id", data.customerId).maybeSingle();
    if (customerError || !customer || customer.tenant_id !== tenantId) throw new Error("المشترك غير موجود أو غير تابع للمؤسسة الحالية");

    const { data: previousRow } = await context.supabase.from("water_readings").select("current_reading, reading_date, created_at").eq("tenant_id", tenantId).eq("meter_id", data.meterId).neq("status", "rejected").lte("reading_date", data.readingDate).order("reading_date", { ascending: false }).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const previousReading = previousRow?.current_reading ?? 0;

    const result = await runVisionInference(apiKey, data.imageDataUrl, meter.serial, previousReading);
    if (result.serialMatch !== "match" || !result.meterNumber) throw new Error("رفض القراءة: هوية العداد في الصورة لا تطابق العداد المرتبط");
    if (result.ambiguous || result.readingValue == null) throw new Error("رفض القراءة: تعذر استخراج قراءة واضحة");
    if (result.readingValue < previousReading) throw new Error("رفض القراءة: القراءة الحالية أقل من القراءة السابقة");

    const { bytes, mime } = decodeImageDataUrl(data.imageDataUrl);
    const extension = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    const evidencePath = `tenants/${tenantId}/readings/${data.clientUuid}.${extension}`;
    const upload = await context.supabase.storage.from("meter-readings").upload(evidencePath, bytes, { contentType: mime, upsert: false });
    if (upload.error) {
      if (upload.error.statusCode !== "409" && upload.error.statusCode !== 409 && upload.error.error !== "Duplicate") throw new Error(`رفع الصورة الأصلية فشل: ${upload.error.message}`);
    }

    const insert: Database["public"]["Tables"]["water_readings"]["Insert"] = {
      tenant_id: tenantId,
      customer_id: data.customerId,
      meter_id: data.meterId,
      current_reading: result.readingValue,
      reading_date: data.readingDate,
      client_uuid: data.clientUuid,
      reader_id: context.userId,
      photo_url: evidencePath,
      lat: data.latitude ?? null,
      lng: data.longitude ?? null,
      gps_verified: data.gpsVerified === true,
    };
    const { data: reading, error: insertError } = await context.supabase.from("water_readings").insert(insert).select("id").maybeSingle();
    if (insertError) {
      if (upload.data && insertError.code !== "23505") await context.supabase.storage.from("meter-readings").remove([evidencePath]).catch(() => undefined);
      throw new Error(insertError.message);
    }

    return { ...result, saved: true, readingId: reading?.id ?? null, evidencePath };
  });
