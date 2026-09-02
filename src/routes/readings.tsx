import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Camera, CheckCircle2, Image as ImageIcon, Loader2, MapPin, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { fmtYER } from "@/lib/pricing";
import { MeterCamera } from "@/components/meter-camera";
import { getGeoFix, type GeoFix } from "@/lib/geolocation";
import { addPending, isNetworkError, syncPending, useOfflineQueue, type PendingReading } from "@/lib/sync";
import { readFieldCache, requestPersistentStorage, saveFieldCache } from "@/lib/offline-db";
import type { Database } from "@/integrations/supabase/types";

type CustomerRow = Database["public"]["Tables"]["customers"]["Row"];
type ReadingRow = Database["public"]["Tables"]["water_readings"]["Row"];
type MeterLink = { id: string; number: string; customer_id: string };
type FieldCache = { customers: CustomerRow[]; readings: ReadingRow[]; meterLinks: MeterLink[]; readingsCount: number; billsCount: number };

const fieldCacheKey = (tenantId: string) => `field:${tenantId}`;
const normalizeSerial = (v: string) => v.normalize("NFKC").trim().toUpperCase().replace(/[\u2010-\u2015\u2212]/g, "-").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
const extensionFor = (type: string) => type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
const localDateStamp = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export const Route = createFileRoute("/readings")({
  head: () => ({ meta: [{ title: "القراءات — ميزان" }] }),
  component: ReadingsPage,
});

function ReadingsPage() {
  const { user } = useAuth();
  const tenantId = user?.tenantId;
  const isReader = user?.role === "reader";
  const isManager = user?.role === "manager" || user?.role === "super_admin";
  const { items: queue } = useOfflineQueue();

  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [readings, setReadings] = useState<ReadingRow[]>([]);
  const [meterLinks, setMeterLinks] = useState<MeterLink[]>([]);
  const [q, setQ] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [meterId, setMeterId] = useState<string | null>(null);
  const [readingDate, setReadingDate] = useState(() => localDateStamp());
  const [current, setCurrent] = useState("");
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string>();
  const [ocrSerial, setOcrSerial] = useState<string>();
  const [ocrReading, setOcrReading] = useState<number | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [geo, setGeo] = useState<GeoFix | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [offlineSnapshotAt, setOfflineSnapshotAt] = useState<string | null>(null);

  const meterByCustomer = useMemo(() => {
    const m = new Map<string, MeterLink>();
    for (const link of meterLinks) m.set(link.customer_id, link);
    return m;
  }, [meterLinks]);

  const selectedCustomer = customerId ? customers.find(c => c.id === customerId) ?? null : null;
  const selectedMeter = meterId ? meterLinks.find(m => m.id === meterId) ?? null : null;
  const meterNumber = selectedMeter?.number ?? "";

  const previousReading = useMemo(() => {
    if (!meterId) return 0;
    const candidates = readings
      .filter(r => r.meter_id === meterId && r.status !== "rejected" && r.reading_date <= readingDate)
      .sort((a, b) => b.reading_date.localeCompare(a.reading_date) || +new Date(b.created_at) - +new Date(a.created_at));
    return candidates[0]?.current_reading ?? 0;
  }, [readings, meterId, readingDate]);
  const consumption = current === "" ? 0 : Number(current) - previousReading;

  const pendingReadings = useMemo(
    () => readings
      .filter(r => r.status === "pending_approval")
      .sort((a, b) => b.reading_date.localeCompare(a.reading_date) || +new Date(b.created_at) - +new Date(a.created_at)),
    [readings],
  );

  const refresh = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      const snap = await readFieldCache<FieldCache>(fieldCacheKey(tenantId));
      if (snap) {
        setCustomers(snap.data.customers);
        setReadings(snap.data.readings);
        setMeterLinks(snap.data.meterLinks);
        setOfflineSnapshotAt(snap.savedAt);
      }
      setLoading(false);
      return;
    }
    const [cs, rs, ma] = await Promise.all([
      supabase.from("customers").select("*").order("name"),
      supabase.from("water_readings").select("*").order("created_at", { ascending: false }).limit(500),
      supabase.from("meter_assignments").select("meter_id, customer_id, ended_at, meters(serial)").is("ended_at", null),
    ]);
    if (cs.error) toast.error(`تعذّر جلب المشتركين: ${cs.error.message}`); else setCustomers(cs.data ?? []);
    if (!rs.error) setReadings(rs.data ?? []);
    const links: MeterLink[] = !ma.error ? (ma.data ?? []).filter(a => a.customer_id && a.meter_id).map(a => ({
      id: a.meter_id as string,
      customer_id: a.customer_id as string,
      number: ((a as unknown as { meters?: { serial?: string } }).meters?.serial) ?? "",
    })) : [];
    if (!ma.error) setMeterLinks(links);
    if (!cs.error) {
      setOfflineSnapshotAt(null);
      void saveFieldCache<FieldCache>(fieldCacheKey(tenantId), { customers: cs.data ?? [], readings: (rs.data ?? []).slice(0, 300), meterLinks: links, readingsCount: rs.data?.length ?? 0, billsCount: 0 });
      void requestPersistentStorage();
    }
    setLoading(false);
  }, [tenantId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.onLine) void import("@/lib/meter-ocr").then(m => m.prewarmOcrAssets());
  }, []);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return customers.slice(0, 10);
    const compact = (v: string) => v.toLowerCase().replace(/[\s-]/g, "");
    return customers.filter(c => {
      const meter = meterByCustomer.get(c.id)?.number ?? "";
      return c.name.toLowerCase().includes(query) || compact(meter).includes(compact(query)) || (!!c.phone && c.phone.includes(query));
    }).slice(0, 15);
  }, [q, customers, meterByCustomer]);

  function pickCustomer(c: CustomerRow) {
    const meter = meterByCustomer.get(c.id);
    setCustomerId(c.id); setMeterId(meter?.id ?? null); setCurrent(""); setPhotoBlob(null); setPhotoPreview(undefined); setOcrSerial(undefined); setOcrReading(null); setCameraOpen(false);
    if (!meter) toast.error("لا يوجد عداد مرتبط بهذا المشترك");
  }

  function clearPhoto() { setPhotoBlob(null); setPhotoPreview(undefined); setOcrSerial(undefined); setOcrReading(null); setCurrent(""); }

  async function handleCapture(file: File, previewUrl: string) {
    if (!selectedMeter || !meterNumber) return toast.error("اختر المشترك والعداد المرتبط أولاً");
    setPhotoBlob(file); setPhotoPreview(previewUrl); setOcrSerial(undefined); setOcrReading(null); setCurrent(""); setOcrBusy(true);
    try {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        const { recognizeMeterImage } = await import("@/lib/meter-ocr");
        const res = await recognizeMeterImage(file, { knownMeterNumber: meterNumber, previousReading: previousReading });
        if (!res.meterNumberMatch || normalizeSerial(res.meterNumberMatch) !== normalizeSerial(meterNumber)) { clearPhoto(); toast.error(`عذراً، هذه الصورة ليست للعداد المرتبط (${meterNumber}). أعد تصوير العداد الصحيح.`); return; }
        if (res.readingValue == null || res.readingAmbiguous) { toast.error("عذراً، تعذر استخراج قراءة واضحة. أعد التصوير مع تقريب شاشة العداد."); return; }
        setOcrSerial(res.meterNumberMatch); setOcrReading(res.readingValue); setCurrent(String(res.readingValue)); toast.success(`تم التحقق من العداد واستخراج القراءة: ${res.readingValue}`); return;
      }
      const [{ fileToDataUrl }, { readMeterFromImage }] = await Promise.all([import("@/lib/meter-ocr"), import("@/lib/meter-vision.functions")]);
      const ai = await readMeterFromImage({ data: { imageDataUrl: await fileToDataUrl(file), knownMeterNumber: meterNumber, previousReading } });
      if (ai.serialMatch !== "match" || !ai.meterNumber || normalizeSerial(ai.meterNumber) !== normalizeSerial(meterNumber)) { clearPhoto(); toast.error(`عذراً، هذه الصورة ليست للعداد المرتبط (${meterNumber}). أعد تصوير العداد الصحيح.`); return; }
      if (ai.readingValue == null || ai.ambiguous) { toast.error("عذراً، تعذر استخراج قراءة واضحة. أعد التصوير مع تقريب شاشة العداد."); return; }
      setOcrSerial(ai.meterNumber); setOcrReading(ai.readingValue); setCurrent(String(ai.readingValue)); toast.success(`تم التحقق من العداد واستخراج القراءة: ${ai.readingValue}`);
    } catch (e) { console.error("Meter image verification failed", e); clearPhoto(); toast.error((e as Error).message || "تعذر تحليل صورة العداد. أعد التصوير."); }
    finally { setOcrBusy(false); }
  }

  async function captureGeo() {
    setGeoBusy(true);
    try { const fix = await getGeoFix(); setGeo(fix); toast.success(`تم تحديد الموقع بدقة ${fix.accuracy.toFixed(0)} م`); }
    catch (e) { toast.error(`فشل تحديد الموقع: ${(e as Error).message}`); }
    finally { setGeoBusy(false); }
  }

  function resetAfterSave() { setCurrent(""); setPhotoBlob(null); setPhotoPreview(undefined); setOcrSerial(undefined); setOcrReading(null); setGeo(null); setCameraOpen(false); setReadingDate(localDateStamp()); }

  async function saveReading() {
    if (!tenantId || !user) return toast.error("لا توجد جلسة نشطة");
    if (!selectedCustomer) return toast.error("اختر المشترك");
    if (!selectedMeter) return toast.error("لا يوجد عداد مرتبط بهذا المشترك");
    if (!photoBlob) return toast.error("يجب تصوير العداد أولاً");
    if (ocrReading == null || current === "" || Number.isNaN(Number(current))) return toast.error("يجب استخراج القراءة تلقائياً من صورة مطابقة للعداد");
    if (normalizeSerial(ocrSerial ?? "") !== normalizeSerial(meterNumber)) return toast.error("رفض الحفظ: رقم العداد في الصورة غير مطابق");
    if (Number(current) !== ocrReading) return toast.error("رفض الحفظ: القراءة الحالية يجب أن تكون القراءة المستخرجة من الصورة");
    if (Number(current) < previousReading) return toast.error(`رفض الحفظ: القراءة الحالية أقل من السابقة (${previousReading})`);
    let fix = geo;
    if (!fix && isReader) { try { fix = await getGeoFix(); setGeo(fix); } catch (e) { return toast.error(`الموقع مطلوب للقارئ: ${(e as Error).message}`); } }
    setSaving(true);
    const clientUuid = crypto.randomUUID();
    try {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        await addPending({ clientId: clientUuid, meterId: selectedMeter.id, meterNumber: selectedMeter.number, customerId: selectedCustomer.id, current: Number(current), readingDate, by: user.userId, latitude: fix?.lat, longitude: fix?.lng, accuracy: fix?.accuracy, tenantId }, photoBlob);
        toast.success("حُفظت القراءة والصورة محلياً وستتم المزامنة تلقائياً عند عودة الاتصال"); resetAfterSave(); return;
      }
      const extension = extensionFor(photoBlob.type);
      const path = `tenants/${tenantId}/readings/${clientUuid}.${extension}`;
      const up = await supabase.storage.from("meter-readings").upload(path, photoBlob, { contentType: photoBlob.type, upsert: false });
      if (up.error) throw new Error(`رفع الصورة فشل: ${up.error.message}`);
      const { error } = await supabase.from("water_readings").insert({ tenant_id: tenantId, customer_id: selectedCustomer.id, meter_id: selectedMeter.id, current_reading: Number(current), reading_date: readingDate, client_uuid: clientUuid, reader_id: user.userId, photo_url: path, lat: fix?.lat ?? null, lng: fix?.lng ?? null, gps_verified: !!fix } as Database["public"]["Tables"]["water_readings"]["Insert"]);
      if (error) { await supabase.storage.from("meter-readings").remove([path]).catch(() => undefined); if (error.code === "23505" && /one_per_meter_day|client_uuid/i.test(error.message)) throw new Error("توجد قراءة مسجلة لهذا العداد في هذا التاريخ"); throw new Error(error.message); }
      toast.success("تم حفظ القراءة والصورة الأصلية بنجاح"); resetAfterSave(); await refresh();
    } catch (e) {
      if (isNetworkError(e)) {
        try { await addPending({ clientId: clientUuid, meterId: selectedMeter.id, meterNumber: selectedMeter.number, customerId: selectedCustomer.id, current: Number(current), readingDate, by: user.userId, latitude: fix?.lat, longitude: fix?.lng, accuracy: fix?.accuracy, tenantId }, photoBlob); toast.warning("انقطع الاتصال — حُفظت القراءة والصورة محلياً للمزامنة التلقائية"); resetAfterSave(); return; }
        catch { toast.error("تعذر الحفظ المحلي؛ أعد المحاولة قبل مغادرة الصفحة"); return; }
      }
      toast.error((e as Error).message || "تعذر حفظ القراءة");
    } finally { setSaving(false); }
  }

  async function approvePending(id: string) {
    setApprovalBusy(id);
    try {
      const { error } = await supabase.rpc("approve_reading", { _reading_id: id });
      if (error) throw new Error(error.message);
      await refresh();
      toast.success("تم اعتماد القراءة وإصدار الفاتورة وفق قواعد الخادم");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر اعتماد القراءة");
    } finally {
      setApprovalBusy(null);
    }
  }

  async function rejectPending(id: string) {
    const reason = window.prompt("سبب رفض القراءة:", "القراءة تحتاج مراجعة");
    if (reason === null) return;
    setApprovalBusy(id);
    try {
      const { error } = await supabase.rpc("reject_reading", { _reading_id: id, _reason: reason.trim() || null });
      if (error) throw new Error(error.message);
      await refresh();
      toast.success("تم رفض القراءة وتسجيل سبب الرفض");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر رفض القراءة");
    } finally {
      setApprovalBusy(null);
    }
  }

  return <div className="space-y-6">
    <div className="flex items-start justify-between gap-3"><div><h1 className="text-2xl md:text-3xl font-bold">القراءات</h1><p className="text-sm text-muted-foreground mt-1">الصورة الأصلية محفوظة دون ضغط، ولا تُقبل القراءة إلا بعد التحقق التام من رقم العداد.</p></div><Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}><RefreshCw className={`w-4 h-4 ms-1 ${loading ? "animate-spin" : ""}`} /> تحديث</Button></div>
    {offlineSnapshotAt && <div className="rounded-md border px-3 py-2 text-xs bg-amber-500/10">وضع الأوفلاين — البيانات من لقطة محلية محفوظة بتاريخ {new Date(offlineSnapshotAt).toLocaleString("ar")}.</div>}
    <Card><CardHeader><CardTitle>تسجيل قراءة</CardTitle></CardHeader><CardContent className="space-y-4">
      <div><Label>المشترك</Label><Input value={q} onChange={e => { setQ(e.target.value); if (customerId) { setCustomerId(null); setMeterId(null); clearPhoto(); } }} placeholder="الاسم / رقم العداد / الهاتف" />{q && !selectedCustomer && <div className="mt-2 border rounded-md divide-y max-h-64 overflow-auto">{results.length === 0 ? <div className="p-3 text-sm text-muted-foreground text-center">لا توجد نتائج</div> : results.map(c => <button key={c.id} type="button" onClick={() => { pickCustomer(c); setQ(`${c.name} · ${meterByCustomer.get(c.id)?.number ?? "بدون عداد"}`); }} className="w-full text-right p-3 hover:bg-muted/50 text-sm flex justify-between gap-3"><span className="font-medium">{c.name}</span><span className="text-xs text-muted-foreground" dir="ltr">{meterByCustomer.get(c.id)?.number ?? "بدون عداد"} · {c.phone ?? "—"}</span></button>)}</div>}</div>
      {selectedCustomer && <div className="rounded-lg border p-3 bg-muted/30 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs"><Info label="الاسم">{selectedCustomer.name}</Info><Info label="الهاتف"><span dir="ltr">{selectedCustomer.phone ?? "—"}</span></Info><Info label="القراءة السابقة"><span className="font-mono">{previousReading}</span></Info><Info label="الرصيد">{fmtYER(selectedCustomer.balance)}</Info></div>}
      <div className="grid md:grid-cols-2 gap-3"><div><Label>رقم العداد المرتبط</Label><Input value={meterNumber} readOnly dir="ltr" className="font-mono bg-muted/40" placeholder="يظهر بعد اختيار المشترك" /></div><div><Label>القراءة الحالية</Label><Input type="number" value={current} readOnly aria-readonly placeholder={ocrBusy ? "جاري استخراج القراءة…" : "تُملأ تلقائياً بعد نجاح التحقق"} className="bg-muted/40" /></div></div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setCameraOpen(v => !v)} disabled={!selectedMeter || ocrBusy}><Camera className="w-4 h-4 ms-1" /> {cameraOpen ? "إخفاء الكاميرا" : "تصوير العداد"}</Button><Button variant="outline" onClick={() => void captureGeo()} disabled={geoBusy}><MapPin className="w-4 h-4 ms-1" /> {geo ? "تم تحديد الموقع" : "تحديد الموقع"}</Button></div>
      {cameraOpen && <MeterCamera onCapture={handleCapture} onClear={clearPhoto} initialPreview={photoPreview} disabled={ocrBusy || saving} />}
      {ocrBusy && <div className="rounded-lg border p-3 flex items-center gap-2 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> جارٍ التحقق من رقم العداد واستخراج القراءة…</div>}
      {ocrSerial && <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 flex items-center gap-2 text-sm"><ShieldCheck className="w-4 h-4" /> رقم العداد مطابق تماماً: <span className="font-mono" dir="ltr">{ocrSerial}</span></div>}
      {ocrReading != null && <div className="rounded-lg border p-3 grid grid-cols-3 gap-3 text-sm"><Info label="القراءة المستخرجة"><span className="font-mono">{ocrReading}</span></Info><Info label="السابقة"><span className="font-mono">{previousReading}</span></Info><Info label="الاستهلاك"><span className="font-mono">{consumption.toFixed(1)} م³</span></Info></div>}
      {photoPreview && <div className="flex items-center gap-2 text-xs"><Badge variant="outline"><ImageIcon className="w-3 h-3 ms-1" /> الصورة الأصلية جاهزة</Badge><img src={photoPreview} alt="معاينة صورة العداد" className="h-20 rounded border object-contain" /></div>}
      <div><Label>تاريخ القراءة</Label><Input type="date" dir="ltr" value={readingDate} max={localDateStamp()} onChange={e => setReadingDate(e.target.value)} /></div>
      <Button size="lg" onClick={() => void saveReading()} disabled={saving || ocrBusy || !photoBlob || ocrReading == null || !selectedMeter || !selectedCustomer} className="w-full md:w-auto">{saving ? <><Loader2 className="w-4 h-4 ms-1 animate-spin" /> جاري الحفظ…</> : <><CheckCircle2 className="w-4 h-4 ms-1" /> حفظ القراءة</>}</Button>
    </CardContent></Card>

    {isManager && pendingReadings.length > 0 && <Card>
      <CardHeader><CardTitle className="text-base">قراءات بانتظار اعتماد الإدارة ({pendingReadings.length})</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {pendingReadings.map(r => {
          const busy = approvalBusy === r.id;
          return <div key={r.id} className="rounded-md border p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div className="text-sm space-y-1">
              <div><span className="text-muted-foreground">العداد:</span> <span className="font-mono" dir="ltr">{r.meter_number}</span></div>
              <div><span className="text-muted-foreground">التاريخ:</span> {r.reading_date} · <span className="text-muted-foreground">القراءة:</span> <span className="font-mono">{r.current_reading}</span></div>
              <div><span className="text-muted-foreground">السبب:</span> <Badge variant="outline">{r.flag ?? "مراجعة"}</Badge></div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void approvePending(r.id)} disabled={busy}><CheckCircle2 className="w-3 h-3 ms-1" /> {busy ? "جارٍ…" : "اعتماد"}</Button>
              <Button size="sm" variant="destructive" onClick={() => void rejectPending(r.id)} disabled={busy}><XCircle className="w-3 h-3 ms-1" /> رفض</Button>
            </div>
          </div>;
        })}
      </CardContent>
    </Card>}

    {queue.length > 0 && <Card><CardHeader className="flex flex-row items-center justify-between"><CardTitle className="text-base">قراءات محفوظة على الجهاز ({queue.filter((p: PendingReading) => p.status !== "synced").length})</CardTitle><Button size="sm" variant="outline" onClick={() => void syncPending(true)}><RefreshCw className="w-3 h-3 ms-1" /> مزامنة الآن</Button></CardHeader><CardContent className="space-y-2">{queue.filter((p: PendingReading) => p.status !== "synced").slice(0, 20).map(p => <div key={p.clientId} className="rounded-md border p-2 text-xs">عداد <span className="font-mono" dir="ltr">{p.meterNumber}</span> — قراءة <span className="font-mono">{p.current}</span> — {p.status}</div>)}</CardContent></Card>}
  </div>;
}

function Info({ label, children }: { label: string; children: ReactNode }) { return <div><div className="text-muted-foreground">{label}</div><div className="font-medium mt-0.5">{children}</div></div>; }
