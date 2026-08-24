/**
 * قراءة أرقام عداد المياه من صورة (OCR) — وحدة محلية قابلة للنقل.
 *
 * لا تعتمد على قاعدة بيانات ولا على متغيرات بيئة، وتستخدم مكتبة tesseract.js
 * الموجودة أصلاً ضمن اعتماديات المشروع، ويتم تحميلها بشكل كسول (dynamic import)
 * داخل المتصفح فقط حتى لا تدخل في مسار SSR.
 *
 * المبدأ:
 *  - رقم العداد (Meter Number) معروف مسبقاً من بيانات المشترك، ولا يُستنتج من الصورة.
 *    نستخدم OCR فقط للتحقق: هل يظهر نفس الرقم على جسم العداد؟
 *  - القراءة الحالية (Current Reading) تُستخرج من أكبر مجموعة أرقام في شاشة العداد
 *    (خانات العدّاد الميكانيكية عادةً أكبر ارتفاعاً من باقي الطباعة)، مع استبعاد
 *    الرقم المطابق لرقم العداد المعروف.
 *  - كل ما تبقى (أرقام تسلسلية، وحدات، تواريخ، علامة تجارية، رموز فنية) يُعاد
 *    كقائمة "أرقام/نصوص أخرى" للعرض فقط، ولا يدخل في أي حساب.
 */

export interface OcrToken {
  text: string;
  confidence: number;
  /** ارتفاع الكلمة بالبكسل — مؤشر على حجم الخط داخل الصورة */
  height: number;
  kind: "reading" | "meter-number" | "date" | "unit" | "other";
}

export interface MeterOcrResult {
  rawText: string;
  tokens: OcrToken[];
  /** رقم العداد المعروف إن تم العثور عليه في الصورة (تحقق فقط) */
  meterNumberMatch: string | null;
  /** القراءة الحالية المرشحة (نص كما ظهر) */
  readingCandidate: string | null;
  /** القراءة الحالية كرقم، أو null إن تعذر الاستخراج بثقة */
  readingValue: number | null;
  /** درجة ثقة القراءة المرشحة 0-100 */
  readingConfidence: number;
  /** عدة مرشحين متقاربين — لا يجوز التخمين، يُطلب إدخال يدوي */
  readingAmbiguous: boolean;
  /** بقية الأرقام والنصوص التي ظهرت على العداد (للعرض فقط) */
  otherTokens: OcrToken[];
}

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

/** توحيد الأرقام العربية/الفارسية إلى أرقام لاتينية */
export function normalizeDigits(input: string): string {
  return input.replace(ARABIC_DIGITS, (d) => {
    const code = d.charCodeAt(0);
    if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
    return String(code - 0x06f0);
  });
}

/** تطبيع للمقارنة: إزالة المسافات والشرطات ورفع الحروف */
export function normalizeSerial(v: string): string {
  return normalizeDigits(v).replace(/[-\s._]/g, "").toUpperCase();
}

const DATE_RE = /^(19|20)\d{2}$|^\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?$/;
const UNIT_RE = /^(m3|m³|cbm|kwh|lt|l|kg|bar|°c|mm|cm)$/i;

function classify(
  text: string,
  knownSerialNorm: string,
  isReadingCandidate: boolean
): OcrToken["kind"] {
  const norm = normalizeSerial(text);
  if (knownSerialNorm && norm === knownSerialNorm) return "meter-number";
  if (UNIT_RE.test(text.trim())) return "unit";
  if (DATE_RE.test(normalizeDigits(text.trim()))) return "date";
  if (isReadingCandidate) return "reading";
  return "other";
}

/** هل يصلح النص كقراءة عدّاد؟ خانات أرقام متتالية مع كسر عشري اختياري */
function readingShape(text: string): { ok: boolean; value: number | null } {
  const t = normalizeDigits(text).replace(/[^\d.,]/g, "").replace(/,/g, ".");
  if (!/^\d{1,8}(\.\d{1,3})?$/.test(t)) return { ok: false, value: null };
  const digits = t.replace(/\D/g, "");
  // خانات العداد عادة بين 3 و 8 أرقام
  if (digits.length < 3 || digits.length > 8) return { ok: false, value: null };
  const value = Number(t);
  if (!Number.isFinite(value)) return { ok: false, value: null };
  return { ok: true, value };
}

export interface RecognizeOptions {
  /** رقم العداد المعروف مسبقاً من بيانات المشترك (لا يُستنتج من الصورة) */
  knownMeterNumber?: string;
  /** القراءة السابقة — تُستخدم فقط لترجيح المرشح، لا لتغيير أي منطق حسابي */
  previousReading?: number | null;
  /** أرقام معروفة من بيانات المشترك (هاتف، معرفات) تُستبعد من المرشحين */
  excludeNumbers?: (string | number | null | undefined)[];
}

/**
 * تشغيل OCR على صورة العداد. لا يقوم بأي حفظ ولا أي حساب استهلاك —
 * يعيد النتيجة فقط ليؤكدها المستخدم يدوياً.
 */
export async function recognizeMeterImage(
  image: Blob | File | string,
  options: RecognizeOptions = {}
): Promise<MeterOcrResult> {
  if (typeof window === "undefined") {
    throw new Error("OCR متاح في المتصفح فقط");
  }

  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");

  try {
    await worker.setParameters({
      tessedit_char_whitelist: "0123456789.,:-/ ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz³°",
    });

    const { data } = await worker.recognize(image as never);
    const rawText = data.text ?? "";

    type RawWord = { text?: string; confidence?: number; bbox?: { y0: number; y1: number } };
    const words: RawWord[] =
      ((data as unknown as { words?: RawWord[] }).words ?? []).filter(Boolean);

    const knownSerialNorm = options.knownMeterNumber
      ? normalizeSerial(options.knownMeterNumber)
      : "";

    // في حال لم توفّر النسخة قائمة الكلمات، نعود إلى تقسيم النص الخام.
    const base =
      words.length > 0
        ? words.map((w) => ({
            text: (w.text ?? "").trim(),
            confidence: typeof w.confidence === "number" ? w.confidence : 0,
            height: w.bbox ? Math.abs(w.bbox.y1 - w.bbox.y0) : 0,
          }))
        : rawText
            .split(/\s+/)
            .filter(Boolean)
            .map((t) => ({ text: t.trim(), confidence: 0, height: 0 }));

    const cleaned = base.filter((w) => w.text.length > 0);

    // أرقام معروفة أخرى من بيانات المشترك (هاتف، معرفات) — تُستبعد كلياً.
    const excluded = new Set(
      (options.excludeNumbers ?? [])
        .filter((v) => v != null && String(v).trim() !== "")
        .map((v) => normalizeSerial(String(v)))
    );

    // مرشحو القراءة: أشكال أرقام صالحة، وليست رقم العداد المعروف، وليست تاريخاً.
    const candidates = cleaned
      .map((w) => ({ ...w, shape: readingShape(w.text) }))
      .filter(
        (w) =>
          w.shape.ok &&
          w.shape.value != null &&
          w.shape.value >= 0 &&
          normalizeSerial(w.text) !== knownSerialNorm &&
          !excluded.has(normalizeSerial(w.text)) &&
          !UNIT_RE.test(w.text.trim()) &&
          !DATE_RE.test(normalizeDigits(w.text.trim()))
      );

    // الترجيح: حجم الخط (خانات العداد أكبر) ثم الثقة ثم القرب من القراءة السابقة.
    const prev = options.previousReading ?? null;
    const scored = candidates
      .map((c) => {
        let score = c.height * 2 + c.confidence;
        if (prev != null && c.shape.value != null) {
          if (c.shape.value >= prev) score += 25;
          const delta = Math.abs(c.shape.value - prev);
          if (delta <= Math.max(50, prev * 0.5)) score += 25;
        }
        return { ...c, score };
      })
      .sort((a, b) => b.score - a.score);

    // استبعاد ما يساوي القراءة السابقة تماماً (لا يمثل تغيّراً جديداً)
    const usable = scored.filter((c) => prev == null || c.shape.value !== prev);
    const best = usable[0] ?? null;

    // تقارب المرشحين ⇒ لا تخمين
    const second = usable.find((c) => best && c.shape.value !== best.shape.value) ?? null;
    const readingAmbiguous =
      !!best && !!second && second.score >= best.score * 0.9;

    const tokens: OcrToken[] = cleaned.map((w) => ({
      text: w.text,
      confidence: Math.round(w.confidence),
      height: Math.round(w.height),
      kind: classify(w.text, knownSerialNorm, best ? w.text === best.text : false),
    }));

    const meterNumberMatch =
      knownSerialNorm && cleaned.some((w) => normalizeSerial(w.text) === knownSerialNorm)
        ? (options.knownMeterNumber ?? null)
        : null;

    return {
      rawText,
      tokens,
      meterNumberMatch,
      readingCandidate: best ? best.text : null,
      readingValue: best ? best.shape.value : null,
      readingConfidence: best ? Math.round(best.confidence) : 0,
      otherTokens: tokens.filter((t) => t.kind !== "reading"),
    };
  } finally {
    await worker.terminate();
  }
}
