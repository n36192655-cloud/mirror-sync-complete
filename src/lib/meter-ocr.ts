/**
 * قراءة أرقام عداد المياه من صورة (OCR) — وحدة محلية قابلة للنقل.
 * رقم العداد هو هوية: لا يُقبل إلا التطابق التام بعد التطبيع الآمن للتنسيق.
 */
import { assertMeterImageQuality } from "./meter-image-quality";

export const LOCAL_TESSERACT_OPTIONS = {
  workerPath: "/tesseract/worker.min.js",
  corePath: "/tesseract/",
  langPath: "/tesseract",
  gzip: false,
} as const;

let prewarmed: Promise<boolean> | null = null;

export function prewarmOcrAssets(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (!prewarmed) {
    prewarmed = (async () => {
      try {
        const files = ["/tesseract/worker.min.js", "/tesseract/eng.traineddata", "/tesseract/tesseract-core-simd-lstm.wasm", "/tesseract/tesseract-core-simd-lstm.wasm.js"];
        const cache = typeof caches !== "undefined" ? await caches.open("mizan-ocr") : null;
        for (const f of files) {
          if (cache && (await cache.match(f))) continue;
          const res = await fetch(f, { cache: "force-cache" });
          if (!res.ok) return false;
          if (cache) await cache.put(f, res.clone());
        }
        return true;
      } catch { return false; }
    })();
  }
  return prewarmed;
}

export interface OcrToken { text: string; confidence: number; height: number; kind: "reading" | "meter-number" | "date" | "unit" | "other"; }
export interface MeterOcrResult { rawText: string; tokens: OcrToken[]; meterNumberMatch: string | null; readingCandidate: string | null; readingValue: number | null; readingConfidence: number; readingAmbiguous: boolean; otherTokens: OcrToken[]; }

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
export function normalizeDigits(input: string) { return input.replace(ARABIC_DIGITS, (d) => { const code = d.charCodeAt(0); return code >= 0x0660 && code <= 0x0669 ? String(code - 0x0660) : String(code - 0x06f0); }); }
export function normalizeSerial(v: string) { return normalizeDigits(v).normalize("NFKC").trim().toUpperCase().replace(/[\u2010-\u2015\u2212]/g, "-").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, ""); }

const DATE_RE = /^(19|20)\d{2}$|^\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?$/;
const UNIT_RE = /^(m3|m³|cbm|kwh|lt|l|kg|bar|°c|mm|cm)$/i;
function classify(text: string, known: string, isReading: boolean): OcrToken["kind"] { const n = normalizeSerial(text); if (known && n === known) return "meter-number"; if (UNIT_RE.test(text.trim())) return "unit"; if (DATE_RE.test(normalizeDigits(text.trim()))) return "date"; if (isReading) return "reading"; return "other"; }
function readingShape(text: string) { const t = normalizeDigits(text).replace(/[^\d.,]/g, "").replace(/,/g, "."); if (!/^\d{1,8}(\.\d{1,3})?$/.test(t)) return { ok: false, value: null as number | null }; const digits = t.replace(/\D/g, ""); if (digits.length < 3 || digits.length > 8) return { ok: false, value: null as number | null }; const value = Number(t); return Number.isFinite(value) ? { ok: true, value } : { ok: false, value: null as number | null }; }

export interface RecognizeOptions { knownMeterNumber?: string; previousReading?: number | null; excludeNumbers?: (string | number | null | undefined)[]; }
interface FlatWord { text: string; confidence: number; height: number; }
function flattenWords(data: unknown): FlatWord[] {
  const out: FlatWord[] = [];
  type W = { text?: string; confidence?: number; bbox?: { y0: number; y1: number } }; type L = { words?: W[] }; type P = { lines?: L[] }; type B = { paragraphs?: P[] };
  const d = data as { blocks?: B[] | null; words?: W[] | null };
  const push = (w?: W) => { const text = (w?.text ?? "").trim(); if (!text) return; out.push({ text, confidence: typeof w?.confidence === "number" ? w.confidence : 0, height: w?.bbox ? Math.abs(w.bbox.y1 - w.bbox.y0) : 0 }); };
  for (const b of d.blocks ?? []) for (const p of b?.paragraphs ?? []) for (const l of p?.lines ?? []) for (const w of l?.words ?? []) push(w);
  if (!out.length) for (const w of d.words ?? []) push(w);
  return out;
}

async function preprocess(image: Blob | File | string): Promise<HTMLCanvasElement | Blob | File | string> {
  try {
    const src = typeof image === "string" ? image : URL.createObjectURL(image); const img = new Image(); img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error("image load failed")); img.src = src; });
    const maxW = 1600; const scale = img.naturalWidth > maxW ? maxW / img.naturalWidth : 1; const w = Math.max(1, Math.round(img.naturalWidth * scale)); const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h; const ctx = canvas.getContext("2d"); if (!ctx) return image; ctx.drawImage(img, 0, 0, w, h);
    if (typeof image !== "string") URL.revokeObjectURL(src);
    const px = ctx.getImageData(0, 0, w, h); const a = px.data; let sum = 0;
    for (let i = 0; i < a.length; i += 4) { const g = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2]; a[i] = a[i + 1] = a[i + 2] = g; sum += g; }
    const mean = sum / (a.length / 4); const k = 1.6;
    for (let i = 0; i < a.length; i += 4) { const v = Math.max(0, Math.min(255, (a[i] - mean) * k + mean)); a[i] = a[i + 1] = a[i + 2] = v; }
    ctx.putImageData(px, 0, 0); return canvas;
  } catch { return image; }
}

/** Compatibility signature retained for callers. maxSide/quality are intentionally ignored: no compression or re-encoding occurs. */
export async function imageToCompressedDataUrl(file: Blob, _maxSide?: number, _quality?: number): Promise<string> { return fileToDataUrl(file); }

const MAX_VISION_DATA_URL_LENGTH = 7_500_000; const MAX_VISION_SIDE = 2200;
function blobToDataUrl(file: Blob): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error ?? new Error("تعذر قراءة الصورة")); reader.readAsDataURL(file); }); }

async function createVisionDataUrl(file: Blob): Promise<string> {
  await assertMeterImageQuality(file);
  const original = await blobToDataUrl(file); if (original.length <= MAX_VISION_DATA_URL_LENGTH) return original; if (typeof window === "undefined") throw new Error("تحليل الصورة متاح في المتصفح فقط");
  const src = URL.createObjectURL(file);
  try {
    const img = new Image(); await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error("تعذر تجهيز الصورة للتحليل")); img.src = src; });
    const scale = Math.min(1, MAX_VISION_SIDE / Math.max(img.naturalWidth, img.naturalHeight)); const width = Math.max(1, Math.round(img.naturalWidth * scale)); const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("تعذر تجهيز الصورة للتحليل"); ctx.drawImage(img, 0, 0, width, height);
    let quality = 0.88;
    for (let attempt = 0; attempt < 5; attempt += 1) { const candidate = canvas.toDataURL("image/jpeg", quality); if (candidate.length <= MAX_VISION_DATA_URL_LENGTH) return candidate; quality -= 0.1; }
    const fallback = canvas.toDataURL("image/jpeg", 0.45); if (fallback.length > MAX_VISION_DATA_URL_LENGTH) throw new Error("تعذر تجهيز نسخة تحليل مناسبة للصورة؛ احتفظنا بالصورة الأصلية كما هي."); return fallback;
  } finally { URL.revokeObjectURL(src); }
}

/** Returns an AI-safe derived image when needed; the supplied Blob is never modified or re-encoded for storage. */
export async function fileToDataUrl(file: Blob): Promise<string> { return createVisionDataUrl(file); }

export async function recognizeMeterImage(image: Blob | File | string, options: RecognizeOptions = {}): Promise<MeterOcrResult> {
  if (typeof window === "undefined") throw new Error("OCR متاح في المتصفح فقط");
  if (typeof image !== "string") await assertMeterImageQuality(image);
  const { createWorker } = await import("tesseract.js"); const worker = await createWorker("eng", 1, LOCAL_TESSERACT_OPTIONS);
  try {
    const input = await preprocess(image); const general = await worker.recognize(input as never, {}, { text: true, blocks: true } as never); const rawText = general.data.text ?? ""; const generalWords = flattenWords(general.data); let digitWords: FlatWord[] = [];
    try { await worker.setParameters({ tessedit_char_whitelist: "0123456789.," }); const digits = await worker.recognize(input as never, {}, { text: true, blocks: true } as never); digitWords = flattenWords(digits.data); await worker.setParameters({ tessedit_char_whitelist: "" }); } catch { digitWords = []; }
    const known = options.knownMeterNumber ? normalizeSerial(options.knownMeterNumber) : "";
    const fallback = !generalWords.length && !digitWords.length ? rawText.split(/\s+/).filter(Boolean).map((t) => ({ text: t.trim(), confidence: 0, height: 0 })) : [];
    const cleaned = [...generalWords, ...digitWords, ...fallback].filter((w) => w.text.length > 0);
    const excluded = new Set((options.excludeNumbers ?? []).filter((v) => v != null && String(v).trim() !== "").map((v) => normalizeSerial(String(v))));
    const serialProven = !known || cleaned.some((w) => normalizeSerial(w.text) === known);
    const candidates = cleaned.map((w) => ({ ...w, shape: readingShape(w.text) })).filter((w) => w.shape.ok && w.shape.value != null && w.shape.value >= 0 && normalizeSerial(w.text) !== known && !excluded.has(normalizeSerial(w.text)) && !UNIT_RE.test(w.text.trim()) && !DATE_RE.test(normalizeDigits(w.text.trim())));
    const prev = options.previousReading ?? null;
    const scored = candidates.map((c) => { const digitLen = normalizeDigits(c.text).replace(/\D/g, "").length; let score = c.height * 2 + c.confidence + digitLen * 8; if (prev != null && c.shape.value != null) { if (c.shape.value >= prev) score += 25; if (Math.abs(c.shape.value - prev) <= Math.max(50, prev * 0.5)) score += 25; } return { ...c, score }; }).sort((a, b) => b.score - a.score);
    const filteredPrev = scored.filter((c) => prev == null || c.shape.value !== prev); const seen = new Set<number>(); const usable = filteredPrev.filter((c) => { const v = c.shape.value as number; if (seen.has(v)) return false; seen.add(v); return true; }); const best = usable[0] ?? null; const second = usable[1] ?? null; const readingAmbiguous = !!best && !!second && second.score >= best.score * 0.97;
    const tokens: OcrToken[] = cleaned.map((w) => ({ text: w.text, confidence: Math.round(w.confidence), height: Math.round(w.height), kind: classify(w.text, known, best ? w.text === best.text : false) }));
    const meterNumberMatch = serialProven ? (options.knownMeterNumber ?? null) : null;
    if (known && !serialProven) throw new Error(`عذراً، تعذر إثبات رقم العداد المرتبط (${options.knownMeterNumber}). أعد تصوير الرقم كاملاً وبوضوح.`);
    return { rawText, tokens, meterNumberMatch, readingCandidate: best?.text ?? null, readingValue: best?.shape.value ?? null, readingConfidence: best ? Math.round(best.confidence) : 0, readingAmbiguous, otherTokens: tokens.filter((t) => t.kind !== "reading") };
  } finally { await worker.terminate(); }
}
