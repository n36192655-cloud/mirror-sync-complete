import React, { useRef, useState, useCallback, useEffect } from "react";
import { Camera, RefreshCw, Upload, Check, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface MeterCameraProps {
  onCapture: (imageFile: File, previewUrl: string) => void;
  onClear?: () => void;
  initialPreview?: string;
  disabled?: boolean;
}

/**
 * التقاط الصورة الأصلية دون إعادة تحجيم أو ضغط إضافي.
 * نفضّل ImageCapture.takePhoto() للحصول على لقطة الكاميرا الأصلية،
 * مع fallback إلى PNG كامل الدقة من إطار الفيديو عند عدم توفر ImageCapture.
 */
async function captureOriginalFrame(
  video: HTMLVideoElement,
  stream: MediaStream,
): Promise<{ file: File; previewUrl: string }> {
  const track = stream.getVideoTracks()[0];

  if (typeof window !== "undefined" && "ImageCapture" in window && track) {
    try {
      const ImageCaptureCtor = (window as unknown as {
        ImageCapture: new (track: MediaStreamTrack) => { takePhoto: () => Promise<Blob> };
      }).ImageCapture;
      const imageCapture = new ImageCaptureCtor(track);
      const blob = await imageCapture.takePhoto();
      if (blob.size > 0) {
        const file = new File([blob], `meter_${Date.now()}.${blob.type.includes("png") ? "png" : "jpg"}`, {
          type: blob.type || "image/jpeg",
          lastModified: Date.now(),
        });
        return { file, previewUrl: URL.createObjectURL(file) };
      }
    } catch (error) {
      console.warn("[Mizan] ImageCapture.takePhoto unavailable; using lossless frame fallback", error);
    }
  }

  if (!video.videoWidth || !video.videoHeight) {
    throw new Error("camera frame is not ready");
  }

  const canvas = document.createElement("canvas");
  // لا يوجد MAX_WIDTH/MAX_HEIGHT ولا resize: نحافظ على كامل دقة إطار الكاميرا.
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("canvas unavailable");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) resolve(value);
      else reject(new Error("failed to create lossless image"));
    }, "image/png");
  });

  const file = new File([blob], `meter_${Date.now()}.png`, {
    type: "image/png",
    lastModified: Date.now(),
  });
  return { file, previewUrl: URL.createObjectURL(file) };
}

const CONSTRAINT_CHAIN: MediaStreamConstraints[] = [
  {
    video: {
      facingMode: { exact: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  },
  {
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  },
  { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
  { video: true, audio: false },
];

function describeCameraError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "تم رفض إذن الكاميرا. افتح إعدادات المتصفح واسمح بالوصول للكاميرا لهذا الموقع، ثم أعد المحاولة.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "لم يتم العثور على كاميرا خلفية متاحة على هذا الجهاز.";
    case "NotReadableError":
    case "AbortError":
      return "الكاميرا مشغولة من تطبيق آخر أو تعذّر تشغيلها. أغلق التطبيقات الأخرى التي تستخدم الكاميرا ثم أعد المحاولة.";
    default:
      return "تعذر فتح الكاميرا. تأكد من صلاحيات الكاميرا واستخدام اتصال آمن (HTTPS).";
  }
}

export const MeterCamera: React.FC<MeterCameraProps> = ({
  onCapture,
  onClear,
  initialPreview,
  disabled = false,
}) => {
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

  const stopCamera = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => {
        try { track.stop(); } catch { /* ignore */ }
      });
      streamRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      try { video.pause(); } catch { /* ignore */ }
      video.srcObject = null;
      video.removeAttribute("src");
      video.load();
    }
    setIsStreamReady(false);
    setIsCameraActive(false);
  }, []);

  const cleanupPreview = useCallback(() => {
    const url = previewUrlRef.current;
    if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
    previewUrlRef.current = null;
  }, []);

  const applyPreview = useCallback((url: string) => {
    previewUrlRef.current = url;
    setPreviewUrl(url);
  }, []);

  useEffect(() => () => {
    stopCamera();
    cleanupPreview();
  }, [stopCamera, cleanupPreview]);

  useEffect(() => {
    if (!isCameraActive) return;
    const onHide = () => { if (document.visibilityState === "hidden") stopCamera(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", stopCamera);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", stopCamera);
    };
  }, [isCameraActive, stopCamera]);

  const attachStream = useCallback(async (stream: MediaStream) => {
    const video = videoRef.current;
    if (!video) throw new Error("video element unavailable");
    video.srcObject = stream;
    video.muted = true;
    video.setAttribute("playsinline", "true");
    video.setAttribute("muted", "true");

    if (video.readyState < 2) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          video.removeEventListener("loadedmetadata", finish);
          resolve();
        };
        video.addEventListener("loadedmetadata", finish);
        window.setTimeout(finish, 3000);
      });
    }
    await video.play();
  }, []);

  const startCamera = useCallback(async () => {
    if (disabled || previewUrl) return;
    setError(null);
    if (typeof window !== "undefined" && !window.isSecureContext) {
      setError("الكاميرا تتطلب اتصالاً آمناً (HTTPS).");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("هذا المتصفح لا يدعم الكاميرا المباشرة.");
      return;
    }

    setIsStarting(true);
    setIsCameraActive(true);
    setIsStreamReady(false);
    let stream: MediaStream | null = null;
    let lastError: unknown = null;
    for (const constraints of CONSTRAINT_CHAIN) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!stream) {
      setIsStarting(false);
      setIsCameraActive(false);
      setError(describeCameraError(lastError));
      return;
    }
    streamRef.current = stream;
    if (!videoRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setIsStarting(false);
      setIsCameraActive(false);
      setError("تعذر تجهيز معاينة الكاميرا.");
      return;
    }
    try {
      await attachStream(stream);
      setIsStreamReady(true);
    } catch (err) {
      console.error("Camera preview error:", err);
      stopCamera();
      setError("تعذر عرض معاينة الكاميرا. أعد المحاولة.");
    } finally {
      setIsStarting(false);
    }
  }, [attachStream, disabled, previewUrl, stopCamera]);

  const capturePhoto = useCallback(async () => {
    if (disabled || previewUrl || isCapturing) return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream || !isStreamReady) {
      setError("لم تكتمل معاينة الكاميرا بعد. انتظر لحظة ثم أعد المحاولة.");
      return;
    }
    setIsCapturing(true);
    setError(null);
    try {
      const { file, previewUrl: newPreview } = await captureOriginalFrame(video, stream);
      cleanupPreview();
      applyPreview(newPreview);
      stopCamera();
      // onCapture لا يُستدعى إلا مرة واحدة لهذه الدورة.
      onCapture(file, newPreview);
    } catch (err) {
      console.error("Error capturing meter photo:", err);
      setError("حدث خطأ أثناء التقاط الصورة الأصلية. أعد المحاولة.");
    } finally {
      setIsCapturing(false);
    }
  }, [applyPreview, cleanupPreview, disabled, isCapturing, isStreamReady, onCapture, previewUrl, stopCamera]);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile || disabled || previewUrl) return;
    if (!selectedFile.type.startsWith("image/")) {
      setError("يرجى اختيار ملف صورة صالح.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (nativeInputRef.current) nativeInputRef.current.value = "";
      return;
    }

    // لا نمرر الصورة عبر canvas ولا نعيد ترميزها: الملف الأصلي هو الذي يُحفظ.
    const originalFile = new File([selectedFile], selectedFile.name || `meter_${Date.now()}`, {
      type: selectedFile.type,
      lastModified: selectedFile.lastModified || Date.now(),
    });
    const newPreview = URL.createObjectURL(originalFile);
    cleanupPreview();
    applyPreview(newPreview);
    stopCamera();
    onCapture(originalFile, newPreview);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (nativeInputRef.current) nativeInputRef.current.value = "";
  }, [applyPreview, cleanupPreview, disabled, onCapture, previewUrl, stopCamera]);

  const handleReset = useCallback(() => {
    cleanupPreview();
    setPreviewUrl(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (nativeInputRef.current) nativeInputRef.current.value = "";
    onClear?.();
  }, [cleanupPreview, onClear]);

  return (
    <div className="flex flex-col items-center justify-center w-full gap-4 p-4 border rounded-xl bg-card shadow-sm dir-rtl">
      {error && (
        <Alert variant="destructive" className="w-full text-right dir-rtl">
          <AlertCircle className="w-4 h-4 ml-2" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!previewUrl && !isCameraActive && (
        <div className="flex flex-col sm:flex-row gap-3 w-full justify-center">
          <Button type="button" onClick={startCamera} disabled={disabled || isStarting} className="gap-2 bg-primary text-primary-foreground">
            <Camera className="w-4 h-4" />
            فتح الكاميرا للالتقاط
          </Button>
          <Button type="button" variant="outline" disabled={disabled || isStarting} onClick={() => nativeInputRef.current?.click()} className="gap-2">
            <Camera className="w-4 h-4" />
            كاميرا النظام
          </Button>
          <Button type="button" variant="outline" disabled={disabled || isStarting} onClick={() => fileInputRef.current?.click()} className="gap-2">
            <Upload className="w-4 h-4" />
            اختيار صورة من المعرض
          </Button>
        </div>
      )}

      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
      <input ref={nativeInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFileUpload} />

      {isCameraActive && (
        <div className="relative w-full max-w-md overflow-hidden rounded-lg bg-black aspect-video flex items-center justify-center">
          <video ref={videoRef} className="w-full h-full object-cover" playsInline autoPlay muted />
          {isStreamReady && (
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute inset-0 bg-black/45 [clip-path:polygon(0_0,100%_0,100%_100%,0_100%,0_32%,12%_32%,12%_68%,88%_68%,88%_32%,0_32%)]" />
              <div className="absolute left-[12%] right-[12%] top-[32%] h-[36%] rounded-md border-2 border-emerald-400/90 shadow-[0_0_0_1px_rgba(0,0,0,.35)]">
                <span className="absolute -top-0.5 -left-0.5 w-5 h-5 border-t-4 border-l-4 border-emerald-300 rounded-tl-md" />
                <span className="absolute -top-0.5 -right-0.5 w-5 h-5 border-t-4 border-r-4 border-emerald-300 rounded-tr-md" />
                <span className="absolute -bottom-0.5 -left-0.5 w-5 h-5 border-b-4 border-l-4 border-emerald-300 rounded-bl-md" />
                <span className="absolute -bottom-0.5 -right-0.5 w-5 h-5 border-b-4 border-r-4 border-emerald-300 rounded-br-md" />
                <span className="absolute inset-x-0 top-1/2 h-px bg-emerald-300/50" />
              </div>
              <p className="absolute top-3 inset-x-0 text-center text-[11px] text-white/95 px-3">
                ضع شبّاك الأرقام داخل الإطار · اقترب حتى تملأ الأرقام الإطار · ثبّت الهاتف
              </p>
            </div>
          )}
          {!isStreamReady && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/90 bg-black/60">
              <Loader2 className="w-4 h-4 animate-spin" /> جاري تشغيل الكاميرا…
            </div>
          )}
          <div className="absolute bottom-4 flex gap-4">
            <Button type="button" onClick={capturePhoto} disabled={disabled || isCapturing || !isStreamReady || !!previewUrl} className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white">
              <Check className="w-4 h-4" />
              {isCapturing ? "جاري التقاط الصورة…" : "التقاط الصورة"}
            </Button>
            <Button type="button" onClick={stopCamera} disabled={isCapturing} variant="destructive">إلغاء</Button>
          </div>
        </div>
      )}

      {previewUrl && (
        <div className="flex flex-col items-center gap-3 w-full max-w-md">
          <div className="relative w-full aspect-video rounded-lg overflow-hidden border bg-black">
            <img src={previewUrl} alt="معاينة صورة العداد" className="w-full h-full object-contain" />
          </div>
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-center">
            تم التقاط صورة واحدة بجودتها الأصلية. لا يمكن التقاط صورة ثانية قبل إعادة ضبط العملية.
          </div>
          <div className="flex flex-wrap gap-2 justify-center">
            <Button type="button" onClick={handleReset} variant="outline" disabled={disabled} className="gap-2 text-destructive border-destructive hover:bg-destructive/10">
              <RefreshCw className="w-4 h-4" /> إعادة الالتقاط
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
