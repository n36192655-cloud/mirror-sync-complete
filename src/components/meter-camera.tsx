import React, { useRef, useState, useCallback, useEffect } from "react";
import { Camera, RefreshCw, Upload, Check, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface MeterCameraProps {
  onCapture: (imageFile: File, previewUrl: string) => void;
  onClear?: () => void;
  initialPreview?: string;
}

/**
 * دالة مساعدة لضغط الصور والحفاظ على وضوح أرقام العداد
 * - الحد الأقصى للأبعاد: 1600x1200
 * - الجودة: JPEG 0.82
 * - الناتج: File حقيقي جاهز للرفع السحابي إلى Supabase Storage Bucket (meter-readings)
 */
const compressImage = (
  source: HTMLVideoElement | HTMLImageElement | ImageBitmap,
  width: number,
  height: number
): Promise<{ file: File; previewUrl: string }> => {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    const MAX_WIDTH = 1600;
    const MAX_HEIGHT = 1200;

    let targetWidth = width;
    let targetHeight = height;

    if (targetWidth > MAX_WIDTH || targetHeight > MAX_HEIGHT) {
      if (targetWidth / targetHeight > MAX_WIDTH / MAX_HEIGHT) {
        targetHeight = Math.round((targetHeight * MAX_WIDTH) / targetWidth);
        targetWidth = MAX_WIDTH;
      } else {
        targetWidth = Math.round((targetWidth * MAX_HEIGHT) / targetHeight);
        targetHeight = MAX_HEIGHT;
      }
    }

    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("تعذر إنشاء سياق الرسم للضغط"));
      return;
    }

    // تنعيم الصورة وحفظ حواف أرقام العداد بدقة عالية
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source as CanvasImageSource, 0, 0, targetWidth, targetHeight);

    canvas.toBlob(
      (blob) => {
        if (blob) {
          const fileName = `meter_${Date.now()}.jpg`;
          const compressedFile = new File([blob], fileName, {
            type: "image/jpeg",
            lastModified: Date.now(),
          });
          const previewUrl = URL.createObjectURL(compressedFile);
          resolve({ file: compressedFile, previewUrl });
        } else {
          reject(new Error("فشل تحويل الصورة إلى Blob"));
        }
      },
      "image/jpeg",
      0.82
    );
  });
};

/** سلسلة قيود متدرجة: كاميرا خلفية للهاتف ← أي كاميرا خلفية ← أي كاميرا (لابتوب). */
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
      return "تم رفض إذن الكاميرا. افتح إعدادات المتصفح واسمح بالوصول للكاميرا لهذا الموقع، ثم أعد المحاولة. يمكنك بدلاً من ذلك اختيار صورة من المعرض.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "لم يتم العثور على كاميرا متاحة على هذا الجهاز. استخدم خيار اختيار صورة من المعرض.";
    case "NotReadableError":
    case "AbortError":
      return "الكاميرا مشغولة من تطبيق آخر أو تعذّر تشغيلها. أغلق التطبيقات الأخرى التي تستخدم الكاميرا ثم أعد المحاولة.";
    default:
      return "تعذر فتح الكاميرا. تأكد من صلاحيات الكاميرا واستخدام اتصال آمن (HTTPS)، أو استخدم صورة من المعرض.";
  }
}

export const MeterCamera: React.FC<MeterCameraProps> = ({
  onCapture,
  onClear,
  initialPreview,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const previewUrlRef = useRef<string | null>(initialPreview ?? null);

  const [isCameraActive, setIsCameraActive] = useState<boolean>(false);
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [isStreamReady, setIsStreamReady] = useState<boolean>(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(initialPreview || null);
  const [error, setError] = useState<string | null>(null);
  const [isCompressing, setIsCompressing] = useState<boolean>(false);

  // إيقاف بث الكاميرا وتفريغ الموارد — يُستدعى عند الإلغاء والالتقاط وunmount
  const stopCamera = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          /* تجاهل */
        }
      });
      streamRef.current = null;
    }

    const video = videoRef.current;
    if (video) {
      try {
        video.pause();
      } catch {
        /* تجاهل */
      }
      video.srcObject = null;
      video.removeAttribute("src");
      video.load();
    }

    setIsStreamReady(false);
    setIsCameraActive(false);
  }, []);

  // تنظيف روابط ObjectURL لمنع تسريب الذاكرة (عبر ref حتى لا يتغير المرجع)
  const cleanupPreview = useCallback(() => {
    const url = previewUrlRef.current;
    if (url && url.startsWith("blob:")) {
      URL.revokeObjectURL(url);
    }
    previewUrlRef.current = null;
  }, []);

  const applyPreview = useCallback((url: string) => {
    previewUrlRef.current = url;
    setPreviewUrl(url);
  }, []);

  // تنظيف نهائي واحد فقط عند إزالة المكوّن — لا يعتمد على previewUrl المتغير
  useEffect(() => {
    return () => {
      stopCamera();
      cleanupPreview();
    };
  }, [stopCamera, cleanupPreview]);

  // إيقاف البث إذا خرج المستخدم من التبويب/الصفحة (منع stream في الخلفية)
  useEffect(() => {
    if (!isCameraActive) return;
    const onHide = () => {
      if (document.visibilityState === "hidden") stopCamera();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", stopCamera);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", stopCamera);
    };
  }, [isCameraActive, stopCamera]);

  const attachStream = useCallback(async (stream: MediaStream) => {
    const video = videoRef.current;
    if (!video) return;

    video.srcObject = stream;
    video.muted = true;
    video.setAttribute("playsinline", "true");
    video.setAttribute("muted", "true");

    // انتظار توفر أبعاد الفيديو فعلياً — يمنع الشاشة السوداء
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

    try {
      await video.play();
    } catch {
      // بعض المتصفحات تمنع التشغيل التلقائي — إعادة محاولة صامتة
      video.muted = true;
      await video.play().catch(() => undefined);
    }
  }, []);

  const startCamera = useCallback(async () => {
    setError(null);

    if (typeof window !== "undefined" && !window.isSecureContext) {
      setError(
        "الكاميرا تتطلب اتصالاً آمناً (HTTPS). افتح التطبيق عبر رابط HTTPS أو استخدم صورة من المعرض."
      );
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        "هذا المتصفح لا يدعم فتح الكاميرا مباشرة. استخدم خيار اختيار صورة من المعرض."
      );
      return;
    }

    setIsStarting(true);
    // إظهار عنصر الفيديو قبل الطلب حتى يكون الـref جاهزاً عند وصول البث
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
      console.error("Camera access error:", lastError);
      setIsStarting(false);
      setIsCameraActive(false);
      setError(describeCameraError(lastError));
      return;
    }

    streamRef.current = stream;

    // إذا أُلغيت العملية أثناء الانتظار، أوقف البث فوراً
    if (!videoRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setIsStarting(false);
      setIsCameraActive(false);
      return;
    }

    try {
      await attachStream(stream);
      setIsStreamReady(true);
    } catch (err) {
      console.error("Camera preview error:", err);
      setError("تعذر عرض معاينة الكاميرا. أعد المحاولة أو استخدم صورة من المعرض.");
      stopCamera();
    } finally {
      setIsStarting(false);
    }
  }, [attachStream, stopCamera]);

  const capturePhoto = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    if (!video.videoWidth || !video.videoHeight) {
      setError("لم تكتمل معاينة الكاميرا بعد. انتظر لحظة ثم أعد المحاولة.");
      return;
    }

    setIsCompressing(true);
    setError(null);

    try {
      const { file, previewUrl: newPreview } = await compressImage(
        video,
        video.videoWidth,
        video.videoHeight
      );

      cleanupPreview();
      applyPreview(newPreview);
      stopCamera();
      onCapture(file, newPreview);
    } catch (err) {
      console.error("Error capturing meter photo:", err);
      setError("حدث خطأ أثناء التقاط وضغط صورة العداد.");
    } finally {
      setIsCompressing(false);
    }
  }, [stopCamera, onCapture, cleanupPreview, applyPreview]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    // حماية مؤكدة من اختيار ملفات غير الصور
    if (!selectedFile.type.startsWith("image/")) {
      setError("يرجى اختيار ملف صورة صالح (JPG, PNG, WEBP).");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setIsCompressing(true);
    setError(null);

    const img = new Image();
    const objectUrl = URL.createObjectURL(selectedFile);

    img.onload = async () => {
      try {
        const { file, previewUrl: newPreview } = await compressImage(
          img,
          img.naturalWidth || 1280,
          img.naturalHeight || 720
        );
        URL.revokeObjectURL(objectUrl);

        cleanupPreview();
        applyPreview(newPreview);
        stopCamera();
        onCapture(file, newPreview);
      } catch (err) {
        console.error("Error compressing gallery image:", err);
        setError("تعذر معالجة وضغط الصورة المختارة.");
      } finally {
        setIsCompressing(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setIsCompressing(false);
      setError("تعذر تحميل ملف الصورة المحدد. يرجى اختيار ملف صورة آخر.");
      if (fileInputRef.current) fileInputRef.current.value = "";
    };

    img.src = objectUrl;
  };

  const handleReset = () => {
    cleanupPreview();
    setPreviewUrl(null);
    setError(null);
    if (onClear) onClear();
  };

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
          <Button
            type="button"
            onClick={startCamera}
            disabled={isCompressing || isStarting}
            className="gap-2 bg-primary text-primary-foreground"
          >
            <Camera className="w-4 h-4" />
            فتح الكاميرا للالتقاط
          </Button>

          <Button
            type="button"
            variant="outline"
            disabled={isCompressing}
            onClick={() => fileInputRef.current?.click()}
            className="gap-2"
          >
            <Upload className="w-4 h-4" />
            اختيار صورة من المعرض
          </Button>
        </div>
      )}

      {/* حقل الملف يبقى دائماً في الشجرة حتى لا يفقد المرجع */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileUpload}
      />

      {isCameraActive && (
        <div className="relative w-full max-w-md overflow-hidden rounded-lg bg-black aspect-video flex items-center justify-center">
          <video
            ref={videoRef}
            className="w-full h-full object-cover"
            playsInline
            autoPlay
            muted
          />

          {!isStreamReady && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/90 bg-black/60">
              <Loader2 className="w-4 h-4 animate-spin" />
              جاري تشغيل الكاميرا…
            </div>
          )}

          <div className="absolute bottom-4 flex gap-4">
            <Button
              type="button"
              onClick={capturePhoto}
              disabled={isCompressing || !isStreamReady}
              variant="default"
              className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              <Check className="w-4 h-4" />
              {isCompressing ? "جاري الضغط..." : "التقاط القراءة"}
            </Button>

            <Button
              type="button"
              onClick={stopCamera}
              disabled={isCompressing}
              variant="destructive"
            >
              إلغاء
            </Button>
          </div>
        </div>
      )}

      {previewUrl && (
        <div className="flex flex-col items-center gap-3 w-full max-w-md">
          <div className="relative w-full aspect-video rounded-lg overflow-hidden border">
            <img
              src={previewUrl}
              alt="معاينة صورة العداد"
              className="w-full h-full object-cover"
            />
          </div>

          <div className="flex flex-wrap gap-2 justify-center">
            <Button
              type="button"
              onClick={handleReset}
              variant="outline"
              className="gap-2 text-destructive border-destructive hover:bg-destructive/10"
            >
              <RefreshCw className="w-4 h-4" />
              إعادة التقاط الصورة
            </Button>
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="w-4 h-4" />
              اختيار صورة من المعرض
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
