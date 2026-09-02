import { create } from "zustand";
import { toast } from "sonner";
import { calcConsumption, type MeterType } from "./pricing";
import { supabase } from "@/integrations/supabase/client";
import { useTariff } from "./tariff";

/**
 * خطأ انتهاء/غياب جلسة Supabase. الواجهة لا يجوز أن تعرض بيانات فارغة
 * وكأنها صحيحة عندما تكون الجلسة مفقودة — يجب إعادة المستخدم لتسجيل الدخول.
 */
export class SessionMissingError extends Error {
  constructor() {
    super("انتهت جلسة الدخول — سجّل الدخول مرة أخرى لعرض البيانات");
    this.name = "SessionMissingError";
  }
}

/** خطأ حقيقي من قاعدة البيانات (RLS/صلاحيات/شبكة) — يُرفع ولا يُبتلع. */
export class DataLoadError extends Error {
  constructor(table: string, detail: string) {
    super(`تعذّر تحميل «${table}» من الخادم: ${detail}`);
    this.name = "DataLoadError";
  }
}

/**
 * PostgREST يفرض حدًّا افتراضيًا (1000 صف) على كل استعلام. عند تجاوز أي جدول
 * هذا الحد كانت الصفوف الأحدث تختفي من الواجهة تمامًا. هذا المُحمِّل يجلب كل
 * الصفوف على دفعات مرتبة تصاعديًا بمفتاح ثابت — لا حدود، ولا بيانات مخفية.
 */
const PAGE = 1000;
async function fetchAll<T = Record<string, unknown>>(
  table: string,
  orderBy: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table as never)
      .select("*")
      .order(orderBy, { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      // لا نُرجع [] بصمت: مصفوفة فارغة تُقرأ في الواجهة كـ«لا توجد بيانات».
      console.error(`[Mizan] fetchAll(${table}) failed:`, error.message);
      throw new DataLoadError(table, error.message);
    }
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/** العدد الحقيقي للصفوف في قاعدة البيانات (COUNT(*)) وليس طول المصفوفة. */
async function countRows(table: string): Promise<number> {
  const { count, error } = await supabase
    .from(table as never)
    .select("id", { count: "exact", head: true });
  if (error) throw new DataLoadError(table, error.message);
  return count ?? 0;
}




export type ApprovalStatus = "pending" | "approved" | "rejected";
/** حالة القراءة كما تخزَّن في قاعدة البيانات (موحّدة بين الواجهة والخادم). */
export type ReadingStatus = "pending_approval" | "approved" | "rejected";

export interface Customer {
  id: number;
  name: string;
  phone: string;
  city: string;
  directorate?: string;
  address?: string;
  pay_account: string;
  status?: "active" | "pending" | "rejected" | "suspended";
  submitted_by?: string;
  submitted_at?: string;
  latitude?: number;
  longitude?: number;
  geo_accuracy?: number;
  geo_captured_at?: string;
  family_members: number;
  /** رصيد المشترك كما تحسبه قاعدة البيانات (مصدر الحقيقة الوحيد للمديونية). */
  balance?: number;
}

export interface Meter {
  id: number;
  customer_id: number;
  number: string;
  type: MeterType;
  status: "active" | "inactive" | "pending";
  photo?: string;
}

export interface Reading {
  id: number;
  serial: string;
  meter_id: number;
  previous: number;
  current: number;
  consumption: number;
  date: string;
  flag: "ok" | "suspicious" | "error";
  status: ReadingStatus;
  photo?: string;
  ocr_serial?: string;
  lat?: number;
  lng?: number;
  accuracy?: number;
  by?: string;
}

export interface Bill {
  id: number;
  serial: string;
  customer_id: number;
  meter_id: number;
  reading_id: number;
  subtotal: number;
  arrears: number;
  total: number;
  /** المبلغ المعتمد المسدَّد كما تسجّله قاعدة البيانات (water_bills.paid_amount). */
  paid?: number;
  status: "unpaid" | "paid" | "partial";
  date: string;
  photo?: string;
}

/** فئات طرق الدفع الموحّدة — تطابق ما يخزّنه الخادم في payments.method. */
export type PaymentMethod = "cash" | "wallet" | "transfer";

/** ترجمة قيمة قاعدة البيانات إلى فئة موحّدة. */
export function normalizePaymentMethod(raw: string): PaymentMethod {
  const v = (raw ?? "").toLowerCase().trim();
  if (v === "cash" || v === "نقدي") return "cash";
  if (v === "wallet" || v === "الكريمي" || v === "محفظة") return "wallet";
  if (v === "transfer" || v === "تحويل") return "transfer";
  return "cash";
}

/** عرض اسم طريقة الدفع بالعربية للواجهة. */
export function paymentMethodLabel(m: PaymentMethod | string): string {
  const n = normalizePaymentMethod(m);
  if (n === "cash") return "نقدي";
  if (n === "wallet") return "الكريمي";
  return "تحويل";
}

export interface Payment {
  id: number;
  bill_id: number;
  amount: number;
  method: PaymentMethod;
  date: string;
  status: ApprovalStatus;
  by?: string;
}

export interface ProductionLog {
  id: number;
  type: MeterType;
  units: number;
  date: string;
  note?: string;
  photo?: string;
}

export function payAccountFor(id: number): string {
  return `KRM-YE-${String(id).padStart(6, "0")}`;
}

function dayStamp(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function nextSerial(prefix: string, id: number): string {
  return `${prefix}-${dayStamp()}-${String(id).padStart(4, "0")}`;
}

const DIRECTORATES = [
  "المظفر", "القاهرة", "صالة", "المعافر", "الشمايتين", "المسراخ", "جبل حبشي", "أخرى",
];
export const TAIZ_DIRECTORATES = DIRECTORATES;

/**
 * المتبقي على الفاتورة = نفس معادلة الخادم في `record_payment`:
 *   total - (المدفوع المعتمد) - (المدفوع قيد الاعتماد)
 * المدفوع المعتمد تؤخذ قيمته المباشرة من `water_bills.paid_amount` عند توفرها.
 */
export function billBalance(bill: Bill, payments: Payment[]): number {
  if (!bill) return 0;
  const approved = bill.paid !== undefined
    ? Number(bill.paid)
    : payments
        .filter((p) => p.bill_id === bill.id && p.status === "approved")
        .reduce((a, p) => a + Number(p.amount || 0), 0);

  const pending = payments
    .filter((p) => p.bill_id === bill.id && p.status === "pending")
    .reduce((a, p) => a + Number(p.amount || 0), 0);

  return Math.max(0, Number(bill.total || 0) - approved - pending);
}

/* =========================================================================
 * تعريفات موحّدة لمؤشرات الاستدامة (مصدر واحد للحقيقة في الواجهة).
 * كل صفحة تعرض NRW أو الاستهلاك أو المؤشرات المالية يجب أن تستدعي هذه الدوال
 * بدل إعادة كتابة المعادلة محلياً — وإلا اختلفت النتائج بين الصفحات.
 * ========================================================================= */

/** الاستهلاك الرسمي يُحتسب فقط من القراءات المعتمدة (approved). */
export function isOfficialReading(r: Reading): boolean {
  return r.status === "approved";
}

/** استهلاك رسمي غير سالب لقراءة واحدة. */
export function readingVolume(r: Reading): number {
  return Math.max(0, Number(r.consumption) || 0);
}

export interface DateRange {
  from?: string;
  to?: string;
}

function inRange(dateISO: string, range?: DateRange): boolean {
  if (!range || (!range.from && !range.to)) return true;
  const t = new Date(dateISO).getTime();
  if (Number.isNaN(t)) return false;
  if (range.from) {
    const f = new Date(range.from).getTime();
    if (!Number.isNaN(f) && t < f) return false;
  }
  if (range.to) {
    const to = new Date(range.to).getTime() + 24 * 3600 * 1000 - 1;
    if (!Number.isNaN(to) && t > to) return false;
  }
  return true;
}

/** إجمالي الاستهلاك الرسمي (القراءات المعتمدة فقط) ضمن فترة اختيارية. */
export function officialConsumption(readings: Reading[], range?: DateRange): number {
  return readings.reduce(
    (a, r) => (isOfficialReading(r) && inRange(r.date, range) ? a + readingVolume(r) : a),
    0,
  );
}

export interface NrwResult {
  produced: number;
  consumed: number;
  loss: number;
  pct: number;
  efficiencyPct: number;
}

/**
 * التعريف الرسمي الوحيد للفاقد (Non-Revenue Water):
 *   الفاقد   = max(0, المُنتج − الاستهلاك الرسمي المعتمد)
 *   النسبة % = (الفاقد ÷ المُنتج) × 100   (صفر إذا لم يوجد إنتاج)
 *   الكفاءة  = 100 − النسبة
 */
export function computeNrw(
  productionLogs: ProductionLog[],
  readings: Reading[],
  range?: DateRange,
): NrwResult {
  const produced = productionLogs.reduce(
    (a, p) => (inRange(p.date, range) ? a + (Number(p.units) || 0) : a),
    0,
  );
  const consumed = officialConsumption(readings, range);
  const loss = Math.max(0, produced - consumed);
  const pct = produced > 0 ? (loss / produced) * 100 : 0;
  return { produced, consumed, loss, pct, efficiencyPct: Math.max(0, 100 - pct) };
}

export interface FinancialSummary {
  totalBilled: number;
  totalCollected: number;
  outstanding: number;
  collectionRate: number;
  paidBills: number;
  unpaidBills: number;
}

/**
 * المؤشرات المالية الموحّدة:
 *   إجمالي الفواتير = Σ bills.total
 *   المحصّل         = Σ bills.paid_amount (المعتمد في قاعدة البيانات) — بلا ازدواج مع payments
 *   المتأخرات       = Σ billBalance(فاتورة غير مسددة) = total − معتمد − قيد الاعتماد
 *   كفاءة التحصيل   = (المحصّل ÷ إجمالي الفواتير) × 100
 */
export function computeFinancials(bills: Bill[], payments: Payment[]): FinancialSummary {
  const totalBilled = bills.reduce((a, b) => a + (Number(b.total) || 0), 0);
  const totalCollected = bills.reduce((a, b) => {
    if (b.paid !== undefined) return a + (Number(b.paid) || 0);
    return (
      a +
      payments
        .filter((p) => p.bill_id === b.id && p.status === "approved")
        .reduce((s, p) => s + (Number(p.amount) || 0), 0)
    );
  }, 0);
  const unpaid = bills.filter((b) => b.status !== "paid");
  const outstanding = unpaid.reduce((a, b) => a + billBalance(b, payments), 0);
  return {
    totalBilled,
    totalCollected,
    outstanding,
    collectionRate: totalBilled > 0 ? (totalCollected / totalBilled) * 100 : 0,
    paidBills: bills.length - unpaid.length,
    unpaidBills: unpaid.length,
  };
}

// Stable UUID -> numeric hash so UI keeps numeric IDs while DB uses UUIDs.
function hashId(uuid: string): number {
  let h = 0;
  for (let i = 0; i < uuid.length; i++) h = ((h << 5) - h + uuid.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const idMap = {
  customer: new Map<number, string>(),
  meter: new Map<number, string>(),
  reading: new Map<number, string>(),
  bill: new Map<number, string>(),
  payment: new Map<number, string>(),
  productionLog: new Map<number, string>(),
};

function saveIdMap() {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem("mizan-id-map", JSON.stringify(Object.fromEntries(Object.entries(idMap).map(([k, v]) => [k, [...v.entries()]])))); } catch { /* ignore */ }
}

function meterError(message: string): string {
  if (/already|duplicate|unique|exists/i.test(message)) return "رقم العداد مستخدم مسبقاً";
  if (/not found|customer|meter/i.test(message)) return "تعذّر ربط العداد بالمشترك";
  return message;
}

type DbCounts = { customers: number; readings: number; bills: number; payments: number };

type State = {
  customers: Customer[];
  meters: Meter[];
  readings: Reading[];
  bills: Bill[];
  payments: Payment[];
  productionLogs: ProductionLog[];
  counts: DbCounts;
  seeded: boolean;
  hydrated: boolean;
  hydrateFromSupabase: () => Promise<void>;
  adminCreateSubscriber: (data: {
    name: string;
    phone: string;
    directorate: string;
    address: string;
    meterNumber: string;
    meterType?: MeterType;
    latitude?: number;
    longitude?: number;
    geoAccuracy?: number;
    familyMembers?: number;
  }) => Promise<Customer>;
  assignMeter: (customerId: number, meterNumber: string, meterType?: MeterType) => Promise<Meter>;
  unassignMeter: (customerId: number, reason?: string) => Promise<void>;
  approveReading: (id: number) => void;
  rejectReading: (id: number, reason?: string) => void;
  addPayment: (input: { billId: number; amount: number; method: PaymentMethod | string; by?: string }) => Payment;
  approvePayment: (id: number) => void;
  rejectPayment: (id: number) => void;
  addProductionLog: (p: Omit<ProductionLog, "id">) => void;
  deleteProductionLog: (id: number) => void;
  computeArrears: (customerId: number, excludeBillId?: number) => number;
  reset: () => void;
};

function initial() {
  return {
    customers: [] as Customer[],
    meters: [] as Meter[],
    readings: [] as Reading[],
    bills: [] as Bill[],
    payments: [] as Payment[],
    productionLogs: [] as ProductionLog[],
    counts: { customers: 0, readings: 0, bills: 0, payments: 0 } as DbCounts,
    seeded: false,
    hydrated: false,
  };
}

// لا يوجد persist للبيانات التشغيلية: مصدر الحقيقة الوحيد هو قاعدة البيانات،
// وأي لقطة محلية قديمة كانت تُظهر بيانات Seed بدل الفواتير الحديثة.
if (typeof window !== "undefined") {
  try { window.localStorage.removeItem("mizan-utility-v2"); } catch { /* ignore */ }
}

export const useStore = create<State>()(
    ((set, get) => ({
      ...initial(),


      hydrateFromSupabase: async () => {
        // جلسة Supabase حقيقية شرط لأي قراءة: بدونها كل الطلبات تُنفَّذ كـ anon
        // فتُرفض بـ permission denied وتظهر الواجهة صفرية بلا سبب واضح.
        const { data: sessionData } = await supabase.auth.getSession();
        if (!sessionData?.session?.access_token) throw new SessionMissingError();
        const { data: userData, error: userErr } = await supabase.auth.getUser();
        if (userErr || !userData?.user) throw new SessionMissingError();

        /* eslint-disable @typescript-eslint/no-explicit-any */
        const [cs, ms, mas, rs, bs, ps, pl, counts] = await Promise.all([
          fetchAll<any>("customers", "created_at"),
          fetchAll<any>("meters", "created_at"),
          fetchAll<any>("meter_assignments", "created_at"),
          fetchAll<any>("water_readings", "created_at"),
          fetchAll<any>("water_bills", "created_at"),
          fetchAll<any>("payments", "created_at"),
          fetchAll<any>("production_log", "logged_at"),
          Promise.all([
            countRows("customers"),
            countRows("water_readings"),
            countRows("water_bills"),
            countRows("payments"),
          ]).then(([customers, readings, bills, payments]) => ({
            customers, readings, bills, payments,
          })),
        ]);
        /* eslint-enable @typescript-eslint/no-explicit-any */

        /* Supabase is not generated with table row types in this legacy store;
         * the dynamic PostgREST rows are contained at this adapter boundary.
         * Keep the explicit any scope narrow instead of weakening lint globally. */
        /* eslint-disable @typescript-eslint/no-explicit-any */
        idMap.customer.clear();
        idMap.meter.clear();
        idMap.reading.clear();
        idMap.bill.clear();
        idMap.payment.clear();
        idMap.productionLog.clear();

        const customers: Customer[] = (cs ?? []).map((c: any) => {
          const nid = hashId(c.id);
          idMap.customer.set(nid, c.id);
          return {
            id: nid, name: c.name, phone: c.phone ?? "", city: "تعز",
            directorate: c.directorate ?? undefined,
            address: c.address ?? undefined,
            pay_account: c.pay_account ?? payAccountFor(nid),
            status: (c.status === "active"
              ? "active"
              : c.status === "suspended"
                ? "suspended"
                : "pending") as Customer["status"],
            latitude: c.latitude ?? undefined, longitude: c.longitude ?? undefined,
            geo_accuracy: c.geo_accuracy ?? undefined,
            geo_captured_at: c.geo_captured_at ?? undefined,
            family_members: Number(c.family_members ?? 5) || 5,
            balance: Number(c.balance ?? 0),
          };
        });

        // العدادات كيان مستقل مرتبط بالمشترك عبر meter_assignments النشطة.
        const serialByMeterUuid = new Map<string, string>((ms ?? []).map((m: any) => [m.id, m.serial as string]));
        const activeAssignments = (mas ?? []).filter((a: any) => !a.ended_at);
        const meterUuidByCustomerUuid = new Map<string, string>();
        const customerUuidByMeterUuid = new Map<string, string>();
        activeAssignments.forEach((a: any) => {
          if (!a.customer_id || !a.meter_id) return;
          meterUuidByCustomerUuid.set(a.customer_id, a.meter_id);
          customerUuidByMeterUuid.set(a.meter_id, a.customer_id);
        });

        const meters: Meter[] = (ms ?? []).map((m: any) => {
          const mid = hashId(m.id);
          idMap.meter.set(mid, m.id);
          const custUuid = customerUuidByMeterUuid.get(m.id);
          return {
            id: mid,
            customer_id: custUuid ? hashId(custUuid) : 0,
            number: m.serial as string,
            type: "water" as MeterType,
            status: (m.status === "active" ? "active" : "inactive") as Meter["status"],
          };
        });

        const customerNumericByUuid = new Map<string, number>((cs ?? []).map((c: any) => [c.id, hashId(c.id)]));

        const readingMeter = new Map<string, number>();
        const readings: Reading[] = (rs ?? []).map((r) => {
          const nid = hashId(r.id);
          idMap.reading.set(nid, r.id);
          const custNum = customerNumericByUuid.get(r.customer_id ?? "") ?? 0;
          const meterUuid = (r as any).meter_id ?? meterUuidByCustomerUuid.get(r.customer_id ?? "") ?? null;
          const mid = meterUuid ? hashId(meterUuid) : 0;
          if (meterUuid) idMap.meter.set(mid, meterUuid);
          readingMeter.set(r.id, mid);
          return {
            id: nid, serial: nextSerial("RD", nid), meter_id: mid,
            previous: Number(r.previous), current: Number(r.current_reading),
            consumption: Number(r.consumption), date: r.created_at,
            flag: (r.flag as Reading["flag"]) ?? "ok",
            status: (r.status === "approved" ? "approved" : r.status === "rejected" ? "rejected" : "pending_approval") as ReadingStatus,
            lat: r.lat ?? undefined, lng: r.lng ?? undefined,
          };
        });

        const bills: Bill[] = (bs ?? []).map((b) => {
          const nid = hashId(b.id);
          idMap.bill.set(nid, b.id);
          return {
            id: nid, serial: nextSerial("INV", nid),
            customer_id: b.customer_id ? hashId(b.customer_id) : 0,
            meter_id: b.reading_id ? (readingMeter.get(b.reading_id) ?? 0) : 0,
            reading_id: b.reading_id ? hashId(b.reading_id) : 0,
            subtotal: Number(b.subtotal), arrears: Number(b.arrears), total: Number(b.total),
            paid: Number(b.paid_amount ?? 0),
            status: (b.status as Bill["status"]) ?? "unpaid",
            date: b.issued_at,
          };
        });

        const payments: Payment[] = (ps ?? []).map((p: any) => {
          const nid = hashId(p.id);
          idMap.payment.set(nid, p.id);
          const raw = (p.status as string | undefined) ?? "approved";
          const status: ApprovalStatus =
            raw === "approved" || raw === "pending" || raw === "rejected"
              ? (raw as ApprovalStatus)
              : "approved";
          return {
            id: nid, bill_id: p.bill_id ? hashId(p.bill_id) : 0,
            amount: Number(p.amount), method: normalizePaymentMethod(p.method), date: p.created_at,
            status,
          };
        });

        const productionLogs: ProductionLog[] = (pl ?? []).map((p) => {
          const nid = hashId(p.id);
          idMap.productionLog.set(nid, p.id);
          return { id: nid, type: "water", units: Number(p.produced_m3), date: p.logged_at, note: p.notes ?? undefined };
        });

        saveIdMap();
        const byNewest = <T extends { date: string }>(arr: T[]) =>
          [...arr].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

        set({
          customers,
          meters,
          readings: byNewest(readings),
          bills: byNewest(bills),
          payments: byNewest(payments),
          productionLogs,
          counts,
          hydrated: true,
          seeded: false,
        });

        void useTariff.getState().load();
        /* eslint-enable @typescript-eslint/no-explicit-any */
      },

      adminCreateSubscriber: async (data) => {
        const s = get();
        const cid = Math.max(0, ...s.customers.map((x) => x.id)) + 1;
        const familyMembers = Math.max(1, Number(data.familyMembers ?? 5) || 5);
        const geoAt = data.latitude != null ? new Date().toISOString() : undefined;

        const { data: tenantRow, error: tenantError } = await supabase.rpc("current_tenant_id");
        if (tenantError || !tenantRow) {
          throw new Error("تعذّر تحديد المؤسسة الحالية — تأكد من تسجيل الدخول بصلاحية مدير");
        }

        const payload = {
          tenant_id: tenantRow as unknown as string,
          name: data.name,
          phone: data.phone,
          directorate: data.directorate,
          address: data.address,
          status: "active",
          latitude: data.latitude ?? null,
          longitude: data.longitude ?? null,
          geo_accuracy: data.geoAccuracy ?? null,
          geo_captured_at: geoAt ?? null,
          family_members: familyMembers,
        };

        const taken = new Set(s.customers.map((c) => c.pay_account));
        let payAccount = payAccountFor(cid);
        while (taken.has(payAccount)) payAccount = payAccountFor(Math.floor(Math.random() * 900000) + 100000);
        /* The Supabase client is untyped for this legacy table access; keep the
         * response value inside this single persistence adapter boundary. */
        /* eslint-disable @typescript-eslint/no-explicit-any */
        let inserted: any = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          const res = await supabase
            .from("customers")
            .insert({ ...payload, pay_account: payAccount })
            .select("*").single();
          if (!res.error && res.data) { inserted = res.data; break; }
          const conflict =
            res.error?.code === "23505" || /duplicate|conflict/i.test(res.error?.message ?? "");
          if (conflict && attempt < 4) {
            payAccount = payAccountFor(Math.floor(Math.random() * 900000) + 100000);
            continue;
          }
          throw new Error(res.error?.message ?? "تعذّر حفظ المشترك في قاعدة البيانات");
        }
        if (!inserted) throw new Error("تعذّر حفظ المشترك في قاعدة البيانات");

        const nid = hashId(inserted.id);
        idMap.customer.set(nid, inserted.id);
        saveIdMap();
        /* eslint-enable @typescript-eslint/no-explicit-any */

        const { error: meterError2 } = await supabase.rpc("assign_meter", {
          _customer_id: inserted.id,
          _serial: data.meterNumber,
          _meter_type: data.meterType ?? "water",
        });
        if (meterError2) throw new Error(meterError(meterError2.message));

        await get().hydrateFromSupabase();

        const after = get();
        const customer =
          after.customers.find((c) => c.id === nid) ?? {
            id: nid, name: data.name, phone: data.phone, city: "تعز",
            directorate: data.directorate, address: data.address,
            pay_account: payAccount, status: "active" as const,
            family_members: familyMembers,
          };
        return customer;
      },

      assignMeter: async (customerId, meterNumber, meterType = "water") => {
        const uuid = idMap.customer.get(customerId);
        if (!uuid) throw new Error("المشترك غير معروف");
        const { data, error } = await supabase.rpc("assign_meter", {
          _customer_id: uuid,
          _serial: meterNumber,
          _meter_type: meterType,
        });
        if (error) throw new Error(meterError(error.message));
        await get().hydrateFromSupabase();
        const meter = get().meters.find((m) => m.customer_id === customerId && m.number === meterNumber);
        if (!meter) throw new Error("تم الربط لكن تعذر تحديث العداد في الواجهة");
        return meter;
      },

      unassignMeter: async (customerId, reason) => {
        const uuid = idMap.customer.get(customerId);
        if (!uuid) throw new Error("المشترك غير معروف");
        const { error } = await supabase.rpc("unassign_meter", {
          _customer_id: uuid,
          _reason: reason ?? "إلغاء الربط",
        });
        if (error) throw new Error(error.message);
        await get().hydrateFromSupabase();
      },

      approveReading: (id) => {
        toast.info("اعتماد القراءة يتم من الخادم بعد التحقق من البيانات");
      },
      rejectReading: (id, reason) => {
        toast.info(`رفض القراءة يتم من الخادم${reason ? `: ${reason}` : ""}`);
      },

      addPayment: (input) => {
        const id = Math.max(0, ...get().payments.map((x) => x.id)) + 1;
        const p: Payment = { id, bill_id: input.billId, amount: input.amount, method: normalizePaymentMethod(input.method), date: new Date().toISOString(), status: "pending", by: input.by };
        set((s) => ({ payments: [p, ...s.payments] }));
        return p;
      },
      approvePayment: (id) => set((s) => ({ payments: s.payments.map((p) => p.id === id ? { ...p, status: "approved" } : p) })),
      rejectPayment: (id) => set((s) => ({ payments: s.payments.map((p) => p.id === id ? { ...p, status: "rejected" } : p) })),
      addProductionLog: (p) => {
        const id = Math.max(0, ...get().productionLogs.map((x) => x.id)) + 1;
        set((s) => ({ productionLogs: [{ ...p, id }, ...s.productionLogs] }));
      },
      deleteProductionLog: (id) => set((s) => ({ productionLogs: s.productionLogs.filter((p) => p.id !== id) })),
      computeArrears: (customerId, excludeBillId) =>
        get().bills.filter((b) => b.customer_id === customerId && b.id !== excludeBillId && b.status !== "paid").reduce((sum, b) => sum + billBalance(b, get().payments), 0),
      reset: () => set(initial()),
    })),
);
