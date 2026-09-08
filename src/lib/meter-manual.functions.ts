import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

interface ManualInput {
  meterId: string;
  customerId: string;
  readingDate: string;
  clientUuid: string;
  currentReading: number;
  attemptCount?: number;
  failureReason?: string;
  originalImageDataUrl?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  gpsVerified?: boolean;
}

const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validate(input: unknown): ManualInput {
  const obj = (input ?? {}) as Record<string, unknown>;
  const meterId = typeof obj.meterId === "string" ? obj.meterId.trim() : "";
  const customerId = typeof obj.customerId === "string" ? obj.customerId.trim() : "";
  const readingDate = typeof obj.readingDate === "string" ? obj.readingDate.trim() : "";
  const clientUuid = typeof obj.clientUuid === "string" ? obj.clientUuid.trim() : "";
  const currentReading = typeof obj.currentReading === "number" && Number.isFinite(obj.currentReading) ? obj.currentReading : NaN;
  const attemptCount = typeof obj.attemptCount === "number" && Number.isInteger(obj.attemptCount) ? obj.attemptCount : 0;
  const failureReason = typeof obj.failureReason === "string" ? obj.failureReason.trim().slice(0, 2000) : "";
  const originalImageDataUrl = obj.originalImageDataUrl == null ? null : typeof obj.originalImageDataUrl === "string" ? obj.originalImageDataUrl : "";
  if (!meterId || !customerId || !/^\d{4}-\d{2}-\d{2}$/.test(readingDate) || !UUID_RE.test(clientUuid)) throw new Error("بيانات القراءة اليدوية غير صالحة");
  if (!Number.isFinite(currentReading) || currentReading < 0) throw new Error("القراءة الحالية غير صالحة");
  if (attemptCount < 0) throw new Error("عدد المحاولات غير صالح");
  if (originalImageDataUrl && (!DATA_URL_RE.test(originalImageDataUrl) || originalImageDataUrl.length > 34_000_000)) throw new Error("الصورة الأصلية غير صالحة");
  return { meterId, customerId, readingDate, clientUuid, currentReading, attemptCount, failureReason: failureReason || undefined, originalImageDataUrl, latitude: typeof obj.latitude === "number" && Number.isFinite(obj.latitude) ? obj.latitude : null, longitude: typeof obj.longitude === "number" && Number.isFinite(obj.longitude) ? obj.longitude : null, gpsVerified: obj.gpsVerified === true };
}

function decodeImageDataUrl(dataUrl: string): { bytes: Uint8Array; mime: "image/jpeg" | "image/png" | "image/webp" } {
  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("الصورة الأصلية غير صالحة");
  const mime = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase() as "image/jpeg" | "image/png" | "image/webp";
  const binary = atob(match[2]);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  if (bytes.length > 25 * 1024 * 1024) throw new Error("حجم الصورة أكبر من الحد المسموح");
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const webp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if ((mime === "image/jpeg" && !jpeg) || (mime === "image/png" && !png) || (mime === "image/webp" && !webp)) throw new Error("محتوى الصورة لا يطابق نوع الملف");
  return { bytes, mime };
}

type ManualProvenanceArgs = {
  p_tenant_id: string;
  p_customer_id: string;
  p_meter_id: string;
  p_current_reading: number;
  p_reading_date: string;
  p_client_uuid: string;
  p_photo_url: string | null;
  p_lat: number | null;
  p_lng: number | null;
  p_gps_verified: boolean;
  p_reading_source: "MANUAL";
  p_attempt_count: number;
  p_failure_reason: string | null;
};

type ManualProvenanceRpc = {
  rpc: (name: "insert_meter_reading_with_provenance", args: ManualProvenanceArgs) => Promise<{
    data: string | null;
    error: { code?: string; message: string } | null;
  }>;
};

export const saveManualMeterReading = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validate)
  .handler(async ({ data, context }) => {
    const client = context.supabase as SupabaseClient<Database>;
    const { data: profile } = await client.from("profiles").select("tenant_id").eq("id", context.userId).maybeSingle();
    if (!profile?.tenant_id) throw new Error("تعذر تحديد المؤسسة للمستخدم الحالي");
    const tenantId = profile.tenant_id;

    const { data: meter } = await client.from("meters").select("id, serial, tenant_id").eq("id", data.meterId).maybeSingle();
    if (!meter || meter.tenant_id !== tenantId) throw new Error("العداد غير موجود أو لا يتبع المؤسسة الحالية");
    const { data: customer } = await client.from("customers").select("id, tenant_id").eq("id", data.customerId).maybeSingle();
    if (!customer || customer.tenant_id !== tenantId) throw new Error("المشترك غير موجود أو لا يتبع المؤسسة الحالية");
    const { data: assignment } = await client.from("meter_assignments").select("customer_id").eq("tenant_id", tenantId).eq("customer_id", data.customerId).eq("meter_id", data.meterId).lte("started_at", `${data.readingDate}T23:59:59.999Z`).or(`ended_at.is.null,ended_at.gte.${data.readingDate}T00:00:00.000Z`).limit(1).maybeSingle();
    if (!assignment) throw new Error("العداد غير مرتبط بالمشترك في تاريخ القراءة");
    const { data: previousRow } = await client.from("water_readings").select("current_reading").eq("tenant_id", tenantId).eq("meter_id", data.meterId).neq("status", "rejected").lte("reading_date", data.readingDate).order("reading_date", { ascending: false }).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (previousRow?.current_reading != null && data.currentReading < previousRow.current_reading) throw new Error("القراءة الحالية أقل من القراءة السابقة");

    let photoUrl: string | null = null;
    let uploadedPath: string | null = null;
    if (data.originalImageDataUrl) {
      const original = decodeImageDataUrl(data.originalImageDataUrl);
      uploadedPath = `tenants/${tenantId}/readings/${data.clientUuid}.${original.mime === "image/png" ? "png" : original.mime === "image/webp" ? "webp" : "jpg"}`;
      const storage = client.storage.from("meter-readings");
      const upload = await storage.upload(uploadedPath, original.bytes, { contentType: original.mime, upsert: false });
      if (upload.error && upload.error.statusCode !== "409") throw new Error(`رفع الصورة الأصلية فشل: ${upload.error.message}`);
      photoUrl = uploadedPath;
    }

    const rpcClient = client as unknown as ManualProvenanceRpc;
    const { data: readingId, error } = await rpcClient.rpc("insert_meter_reading_with_provenance", {
      p_tenant_id: tenantId,
      p_customer_id: data.customerId,
      p_meter_id: data.meterId,
      p_current_reading: data.currentReading,
      p_reading_date: data.readingDate,
      p_client_uuid: data.clientUuid,
      p_photo_url: photoUrl,
      p_lat: data.latitude ?? null,
      p_lng: data.longitude ?? null,
      p_gps_verified: data.gpsVerified === true,
      p_reading_source: "MANUAL",
      p_attempt_count: Math.max(0, data.attemptCount ?? 0),
      p_failure_reason: data.failureReason ?? null,
    });
    if (error) {
      if (uploadedPath && error.code !== "23505") await client.storage.from("meter-readings").remove([uploadedPath]).catch(() => undefined);
      throw new Error(error.message);
    }
    return { saved: true, readingId: typeof readingId === "string" ? readingId : null, readingValue: data.currentReading, meterNumber: meter.serial, evidencePath: photoUrl };
  });
