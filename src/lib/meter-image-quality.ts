export interface MeterImageQuality {
  width: number;
  height: number;
  meanLuma: number;
  clippedFraction: number;
  edgeEnergy: number;
}

const MIN_SIDE = 640;
const MIN_LUMA = 18;
const MAX_LUMA = 242;
const MAX_CLIPPED_FRACTION = 0.55;
const MIN_EDGE_ENERGY = 0.0015;

export async function assessMeterImageQuality(image: Blob | File | string): Promise<MeterImageQuality> {
  if (typeof window === "undefined") throw new Error("فحص جودة الصورة متاح في المتصفح فقط");
  const src = typeof image === "string" ? image : URL.createObjectURL(image);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("تعذر قراءة صورة العداد"));
      img.src = src;
    });
    const scale = Math.min(1, 1000 / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("تعذر فحص جودة الصورة");
    ctx.drawImage(img, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    const gray = new Float32Array(width * height);
    let sum = 0;
    let clipped = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const p = (y * width + x) * 4;
        const luma = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
        gray[y * width + x] = luma;
        sum += luma;
        if (luma <= 8 || luma >= 247) clipped += 1;
      }
    }
    let edgeEnergy = 0;
    let edgeSamples = 0;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const i = y * width + x;
        if (x + 1 < width) { edgeEnergy += Math.abs(gray[i] - gray[i + 1]) / 255; edgeSamples += 1; }
        if (y + 1 < height) { edgeEnergy += Math.abs(gray[i] - gray[i + width]) / 255; edgeSamples += 1; }
      }
    }
    const samples = width * height;
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      meanLuma: samples ? sum / samples : 0,
      clippedFraction: samples ? clipped / samples : 1,
      edgeEnergy: edgeSamples ? edgeEnergy / edgeSamples : 0,
    };
  } finally {
    if (typeof image !== "string") URL.revokeObjectURL(src);
  }
}

export async function assertMeterImageQuality(image: Blob | File | string): Promise<MeterImageQuality> {
  const quality = await assessMeterImageQuality(image);
  if (Math.min(quality.width, quality.height) < MIN_SIDE) throw new Error("الصورة صغيرة جداً لقراءة موثوقة. صوّر العداد كاملاً وبمسافة أقرب.");
  if (quality.meanLuma < MIN_LUMA) throw new Error("الصورة مظلمة جداً لقراءة موثوقة. حسّن الإضاءة وأعد التصوير.");
  if (quality.meanLuma > MAX_LUMA) throw new Error("الصورة شديدة السطوع أو الانعكاس. غيّر زاوية الهاتف وأعد التصوير.");
  if (quality.clippedFraction > MAX_CLIPPED_FRACTION) throw new Error("جزء كبير من الصورة محجوب بالسطوع أو الظلام. أعد التصوير بوضوح أكبر.");
  if (quality.edgeEnergy < MIN_EDGE_ENERGY) throw new Error("الصورة غير واضحة بما يكفي لإثبات الأرقام. ثبّت الهاتف وقرّب العداد ثم أعد التصوير.");
  return quality;
}
