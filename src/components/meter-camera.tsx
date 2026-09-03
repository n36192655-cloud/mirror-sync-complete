import React, { useRef, useState, useCallback, useEffect } from "react";
import { Camera, RefreshCw, Upload, Check, AlertCircle, Loader2, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

export interface MeterCaptureTiming {
  startedAt: number;
  completedAt: number;
}

interface MeterCameraProps {
  onCapture: (imageFile: File, previewUrl: string, timing?: MeterCaptureTiming) => void;
  onClear?: () => void;
  initialPreview?: string;
  disabled?: boolean;
}

async function captureOriginalFrame(video: HTMLVideoElement, stream: MediaStream): Promise<{ file: File; previewUrl: string }> {
  const track = stream.getVideoTracks()[0];
  if (typeof window !== "undefined" && "ImageCapture" in window && track) {
    try {
      const ImageCaptureCtor = (window as unknown as { ImageCapture: new (track: MediaStreamTrack) => { takePhoto: () => Promise<Blob> } }).ImageCapture;
      const blob = await new ImageCaptureCtor(track).takePhoto();
      if (blob.size > 0) {
        const extension = blob.type.includes("png") ? "png" : blob.type.includes("webp") ? "webp" : "jpg";
        const file = new File([blob], `meter_${Date.now()}.${extension}`, { type: blob.type || "image/jpeg", lastModified: Date.now() });
        return { file, previewUrl: URL.createObjectURL(file) };
      }
    } catch (error) {
      console.warn("[Mizan] Native still capture unavailable; using stream-frame fallback", error);
    }
  }
  if (!video.videoWidth || !video.videoHeight) throw new Error("camera frame is not ready");
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("canvas unavailable");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("failed to create capture image")), "image/png"));
  const file = new File([blob], `meter_${Date.now()}.png`, { type: "image/png", lastModified: Date.now() });
  return { file, previewUrl: URL.createObjectURL(file) };
}

const CONSTRAINT_CHAIN: MediaStreamConstraints[] = [
  { video: { facingMode: { exact: "environment" }, width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 30, max: 30 }, ...({ resizeMode: "none" } as MediaTrackConstraints) }, audio: false },
  { video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } }, audio: false },
  { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
  { video: { facingMode: { ideal: "environment" } }, audio: false },
  { video: true, audio: false },
];

function describeCameraError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? "";
  switch (name) {
    case "NotAllowedError": case "SecurityError": return "تم رفض إذن الكاميرا. افتح إعدادات المتصفح واسمح بالوصول للكاميرا لهذا الموقع، ثم أعد المحاولة.";
    case "NotFoundError": return "لم يتم العثور على كاميرا متاحة على هذا الجهاز.";
    case "OverconstrainedError": return "الكاميرا لا تدعم إعدادات التصوير المطلوبة على هذا الجهاز. أعد المحاولة بالإعدادات المتاحة.";
    case "NotReadableError": case "AbortError": return "الكاميرا مشغولة من تطبيق آخر أو تعذّر تشغيلها. أغلق التطبيقات الأخرى التي تستخدم الكاميرا ثم أعد المحاولة.";
    default: return "تعذر فتح الكاميرا. تأكد من صلاحيات الكاميرا واستخدام اتصال آمن (HTTPS).";
  }
}

async function optimizeTrackForMeterCapture(track: MediaStreamTrack): Promise<void> {
  if (!("getCapabilities" in track) || !("applyConstraints" in track)) return;
  try {
    const capabilities = track.getCapabilities() as MediaTrackCapabilities & { focusMode?: string[]; torch?: boolean; zoom?: { min: number; max: number; step?: number } };
    const advanced: Array<MediaTrackConstraintSet & { focusMode?: string; zoom?: number }> = [];
    if (capabilities.focusMode?.includes("continuous")) advanced.push({ focusMode: "continuous" });
    if (capabilities.zoom && Number.isFinite(capabilities.zoom.min) && Number.isFinite(capabilities.zoom.max)) {
      const preferred = Math.min(capabilities.zoom.max, Math.max(capabilities.zoom.min, capabilities.zoom.min + (capabilities.zoom.max - capabilities.zoom.min) * 0.25));
      advanced.push({ zoom: preferred });
    }
    if (advanced.length) await track.applyConstraints({ advanced } as MediaTrackConstraints);
  } catch (error) {
    console.debug("[Mizan] Optional camera optimization skipped", error);
  }
}

export const MeterCamera: React.FC<MeterCameraProps> = ({ onCapture, onClear, initialPreview, disabled = false }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const nativeInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const previewUrlRef = useRef<string | null>(initialPreview ?? null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isStreamReady, setIsStreamReady] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(initialPreview || null);
  const [error, setError] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [cameraResolution, setCameraResolution] = useState<string | null>(null);

  const stopCamera = useCallback(() => {
    const stream = streamRef.current;
    if (stream) { stream.getTracks().forEach((track) => { try { track.stop(); } catch {} }); streamRef.current = null; }
    const video = videoRef.current;
    if (video) { try { video.pause(); } catch {} video.srcObject = null; video.removeAttribute("src"); video.load(); }
    setCameraResolution(null); setIsStreamReady(false); setIsCameraActive(false);
  }, []);
  const cleanupPreview = useCallback(() => { const url = previewUrlRef.current; if (url && url.startsWith("blob:")) URL.revokeObjectURL(url); previewUrlRef.current = null; }, []);
  const applyPreview = useCallback((url: string) => { previewUrlRef.current = url; setPreviewUrl(url); }, []);
  useEffect(() => () => { stopCamera(); cleanupPreview(); }, [stopCamera, cleanupPreview]);
  useEffect(() => {
    if (!isCameraActive) return;
    const onHide = () => { if (document.visibilityState === "hidden") stopCamera(); };
    document.addEventListener("visibilitychange", onHide); window.addEventListener("pagehide", stopCamera);
    return () => { document.removeEventListener("visibilitychange", onHide); window.removeEventListener("pagehide", stopCamera); };
  }, [isCameraActive, stopCamera]);

  const attachStream = useCallback(async (stream: MediaStream) => {
    const video = videoRef.current; if (!video) throw new Error("video element unavailable");
    video.srcObject = stream; video.muted = true; video.setAttribute("playsinline", "true"); video.setAttribute("muted", "true");
    if (video.readyState < 2) await new Promise<void>((resolve) => { let done = false; const finish = () => { if (done) return; done = true; video.removeEventListener("loadedmetadata", finish); resolve(); }; video.addEventListener("loadedmetadata", finish); window.setTimeout(finish, 3000); });
    await video.play();
    const track = stream.getVideoTracks()[0];
    if (track) { await optimizeTrackForMeterCapture(track); const settings = track.getSettings(); if (settings.width && settings.height) setCameraResolution(`${settings.width}×${settings.height}`); }
  }, []);

  const startCamera = useCallback(async () => {
    if (disabled || previewUrl) return; setError(null);
    if (typeof window !== "undefined" && !window.isSecureContext) { setError("الكاميرا تتطلب اتصالاً آمناً (HTTPS)."); return; }
    if (!navigator.mediaDevices?.getUserMedia) { setError("هذا المتصفح لا يدعم الكاميرا المباشرة."); return; }
    setIsStarting(true); setIsCameraActive(true); setIsStreamReady(false);
    let stream: MediaStream | null = null; let lastError: unknown = null;
    for (const constraints of CONSTRAINT_CHAIN) { try { stream = await navigator.mediaDevices.getUserMedia(constraints); break; } catch (err) { lastError = err; } }
    if (!stream) { setIsStarting(false); setIsCameraActive(false); setError(describeCameraError(lastError)); return; }
    streamRef.current = stream;
    if (!videoRef.current) { stream.getTracks().forEach((track) => track.stop()); streamRef.current = null; setIsStarting(false); setIsCameraActive(false); setError("تعذر تجهيز معاينة الكاميرا."); return; }
    try { await attachStream(stream); await new Promise<void>((resolve) => window.setTimeout(resolve, 350)); setIsStreamReady(true); }
    catch (err) { console.error("Camera preview error:", err); stopCamera(); setError("تعذر عرض معاينة الكاميرا. أعد المحاولة."); }
    finally { setIsStarting(false); }
  }, [attachStream, disabled, previewUrl, stopCamera]);

  const capturePhoto = useCallback(async () => {
    if (disabled || previewUrl || isCapturing) return;
    const video = videoRef.current; const stream = streamRef.current;
    if (!video || !stream || !isStreamReady) { setError("لم تكتمل معاينة الكاميرا بعد. انتظر لحظة ثم أعد المحاولة."); return; }
    setIsCapturing(true); setError(null);
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const startedAt = performance.now();
      const { file, previewUrl: newPreview } = await captureOriginalFrame(video, stream);
      const completedAt = performance.now();
      if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) throw new Error("invalid camera capture timing");
      cleanupPreview(); applyPreview(newPreview); stopCamera(); onCapture(file, newPreview, { startedAt, completedAt });
    } catch (err) { console.error("Error capturing meter photo:", err); setError("حدث خطأ أثناء التقاط الصورة الأصلية. أعد المحاولة."); }
    finally { setIsCapturing(false); }
  }, [applyPreview, cleanupPreview, disabled, isCapturing, isStreamReady, onCapture, previewUrl, stopCamera]);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]; if (!selectedFile || disabled || previewUrl) return;
    if (!selectedFile.type.startsWith("image/")) { setError("يرجى اختيار ملف صورة صالح."); if (fileInputRef.current) fileInputRef.current.value = ""; if (nativeInputRef.current) nativeInputRef.current.value = ""; return; }
    const originalFile = new File([selectedFile], selectedFile.name || `meter_${Date.now()}`, { type: selectedFile.type, lastModified: selectedFile.lastModified || Date.now() });
    const newPreview = URL.createObjectURL(originalFile); cleanupPreview(); applyPreview(newPreview); stopCamera(); onCapture(originalFile, newPreview);
    if (fileInputRef.current) fileInputRef.current.value = ""; if (nativeInputRef.current) nativeInputRef.current.value = "";
  }, [applyPreview, cleanupPreview, disabled, onCapture, previewUrl, stopCamera]);

  const handleReset = useCallback(() => {
    cleanupPreview(); setPreviewUrl(null); setError(null); if (fileInputRef.current) fileInputRef.current.value = ""; if (nativeInputRef.current) nativeInputRef.current.value = ""; onClear?.();
  }, [cleanupPreview, onClear]);

  return <div className="flex flex-col items-center justify-center w-full gap-4 p-4 border rounded-xl bg-card shadow-sm dir-rtl">
    {error && <Alert variant="destructive" className="w-full text-right dir-rtl"><AlertCircle className="w-4 h-4 ml-2" /><AlertDescription>{error}</AlertDescription></Alert>}
    {!previewUrl && <>
      <div className="relative w-full max-w-2xl overflow-hidden rounded-lg border bg-black aspect-video">
        <video ref={videoRef} className={`w-full h-full object-contain ${isCameraActive ? "" : "hidden"}`} autoPlay playsInline muted />
        {!isCameraActive && <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground gap-2"><Camera className="w-10 h-10" /><span>الكاميرا غير مفعّلة</span></div>}
        {isCameraActive && isStreamReady && <div className="absolute inset-5 border-2 border-white/60 rounded-md pointer-events-none" />}
      </div>
      {cameraResolution && <div className="text-xs text-muted-foreground" dir="ltr">{cameraResolution}</div>}
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={() => void startCamera()} disabled={disabled || isStarting || isCameraActive}>{isStarting ? <Loader2 className="w-4 h-4 ms-1 animate-spin" /> : <Camera className="w-4 h-4 ms-1" />} {isStarting ? "جاري تشغيل الكاميرا…" : "فتح الكاميرا"}</Button>
        <Button variant="secondary" onClick={() => fileInputRef.current?.click()} disabled={disabled}><Upload className="w-4 h-4 ms-1" /> رفع صورة</Button>
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
        <input ref={nativeInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFileUpload} />
      </div>
      {isCameraActive && <Button size="lg" onClick={() => void capturePhoto()} disabled={disabled || !isStreamReady || isCapturing} className="min-w-48">{isCapturing ? <Loader2 className="w-5 h-5 ms-1 animate-spin" /> : <Check className="w-5 h-5 ms-1" />} {isCapturing ? "جاري الالتقاط…" : "التقاط الصورة الأصلية"}</Button>}
    </>}
    {previewUrl && <div className="w-full max-w-2xl space-y-3"><div className="flex items-center gap-2 text-sm"><Check className="w-4 h-4" /> تم التقاط الصورة الأصلية</div><img src={previewUrl} alt="معاينة صورة العداد" className="w-full max-h-[60vh] rounded-lg border object-contain bg-black" /><Button variant="outline" onClick={handleReset} disabled={disabled}><RefreshCw className="w-4 h-4 ms-1" /> إعادة التصوير</Button></div>}
    <div className="text-xs text-muted-foreground text-center flex items-center gap-1"><Maximize2 className="w-3 h-3" /> الصورة الأصلية لا يتم ضغطها أو تغيير أبعادها قبل المعالجة.</div>
  </div>;
};
