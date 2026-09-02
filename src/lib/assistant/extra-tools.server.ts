import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type DB = SupabaseClient<Database>;

export interface ExtraToolResult {
  ok: boolean;
  data: unknown;
  table?: { title: string; columns: string[]; rows: Array<Array<string | number | null>> };
}

const isUuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const d = (v: unknown) => (typeof v === "string" ? v.slice(0, 10) : "");
const fail = (error: string): ExtraToolResult => ({ ok: false, data: { error } });

const periodProps = {
  customer_id: { type: "string", description: "UUID حقيقي من search_customers" },
  from: { type: "string", description: "بداية الفترة YYYY-MM-DD" },
  to: { type: "string", description: "نهاية الفترة YYYY-MM-DD" },
};

export const EXTRA_ASSISTANT_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_customer_period_summary",
      description: "كشف حساب تحليلي دقيق لمشترك خلال فترة محددة: الاستهلاك المعتمد فقط، إجمالي الفواتير، أعلى وأقل فاتورة، المدفوعات المعتمدة، الفواتير غير المسددة، والرصيد الحالي. استخدمه لأي سؤال عن شهر أو سنة أو فترة زمنية محددة.",
      parameters: { type: "object", properties: periodProps, required: ["customer_id", "from", "to"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_project_efficiency",
      description: "تحليل كفاءة المشروع خلال فترة: الإنتاج المسجل، الاستهلاك المعتمد، الفاقد المائي الظاهري، نسبة الفاقد، والتحصيل. الفاقد الظاهري هو الإنتاج ناقص الاستهلاك المعتمد؛ إذا أصبح الفرق سالباً فهذا مؤشر عدم اتساق في البيانات ويجب عدم وصفه كفاقد.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "بداية الفترة YYYY-MM-DD" },
          to: { type: "string", description: "نهاية الفترة YYYY-MM-DD" },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
  },
] as const;

export async function runExtraAssistantTool(supabase: DB, name: string, args: Record<string, unknown>): Promise<ExtraToolResult> {
  if (name === "get_customer_period_summary") return getCustomerPeriodSummary(supabase, args);
  if (name === "get_project_efficiency") return getProjectEfficiency(supabase, args);
  return fail(`أداة غير معروفة: ${name}`);
}

async function getCustomerPeriodSummary(supabase: DB, args: Record<string, unknown>): Promise<ExtraToolResult> {
  const customerId = args.customer_id;
  const from = typeof args.from === "string" ? args.from : "";
  const to = typeof args.to === "string" ? args.to : "";
  if (!isUuid(customerId)) return fail("customer_id يجب أن يكون UUID حقيقياً من search_customers.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return fail("نطاق التاريخ غير صالح. استخدم YYYY-MM-DD وتأكد أن البداية قبل النهاية.");

  const [{ data: customer, error: customerError }, { data: bills, error: billsError }, { data: payments, error: paymentsError }, { data: readings, error: readingsError }, { data: balance, error: balanceError }] = await Promise.all([
    supabase.from("customers").select("id,name,pay_account,phone").eq("id", customerId).maybeSingle(),
    supabase.from("water_bills").select("bill_number,issued_at,due_date,total,paid_amount,status").eq("customer_id", customerId).gte("issued_at", from).lte("issued_at", `${to}T23:59:59`).order("issued_at", { ascending: true }),
    supabase.from("payments").select("amount,paid_at,method,status").eq("customer_id", customerId).gte("paid_at", from).lte("paid_at", `${to}T23:59:59`).eq("status", "approved").order("paid_at", { ascending: true }),
    supabase.from("water_readings").select("reading_date,current_reading,previous,consumption,status").eq("customer_id", customerId).gte("reading_date", from).lte("reading_date", `${to}T23:59:59`).eq("status", "approved").order("reading_date", { ascending: true }),
    supabase.from("customer_balances").select("current_balance").eq("customer_id", customerId).maybeSingle(),
  ]);
  if (customerError) return fail(customerError.message);
  if (billsError) return fail(billsError.message);
  if (paymentsError) return fail(paymentsError.message);
  if (readingsError) return fail(readingsError.message);
  if (balanceError) return fail(balanceError.message);
  if (!customer) return { ok: true, data: { found: false, note: "المشترك غير موجود ضمن صلاحياتك." } };

  const billList = bills ?? [];
  const paymentList = payments ?? [];
  const readingList = readings ?? [];
  const billed = billList.reduce((s, b) => s + n(b.total), 0);
  const paid = paymentList.reduce((s, p) => s + n(p.amount), 0);
  const consumption = readingList.reduce((s, r) => s + Math.max(n(r.consumption), 0), 0);
  const unpaid = billList.filter((b) => n(b.total) - n(b.paid_amount) > 0.01);
  const unpaidAmount = unpaid.reduce((s, b) => s + Math.max(n(b.total) - n(b.paid_amount), 0), 0);
  const highest = [...billList].sort((a, b) => n(b.total) - n(a.total))[0] ?? null;
  const lowest = [...billList].sort((a, b) => n(a.total) - n(b.total))[0] ?? null;
  const collectionPct = billed > 0 ? Math.round((paid / billed) * 1000) / 10 : 0;

  return {
    ok: true,
    data: {
      found: true,
      period: { from, to },
      customer: { name: customer.name, pay_account: customer.pay_account ?? "", phone: customer.phone ?? "" },
      current_balance: n(balance?.current_balance),
      consumption_m3: consumption,
      readings_count: readingList.length,
      billed_amount: billed,
      bills_count: billList.length,
      highest_bill: highest ? { bill_number: highest.bill_number, date: d(highest.issued_at), amount: n(highest.total) } : null,
      lowest_bill: lowest ? { bill_number: lowest.bill_number, date: d(lowest.issued_at), amount: n(lowest.total) } : null,
      approved_payments_amount: paid,
      approved_payments_count: paymentList.length,
      unpaid_bills_count: unpaid.length,
      unpaid_amount: unpaidAmount,
      collection_pct: collectionPct,
      bills: billList.map((b) => ({ bill_number: b.bill_number ?? "", date: d(b.issued_at), amount: n(b.total), paid: n(b.paid_amount), remaining: Math.max(n(b.total) - n(b.paid_amount), 0), status: b.status })),
      payments: paymentList.map((p) => ({ date: d(p.paid_at), amount: n(p.amount), method: p.method })),
      readings: readingList.map((r) => ({ date: d(r.reading_date), current: n(r.current_reading), previous: n(r.previous), consumption: Math.max(n(r.consumption), 0) })),
    },
    table: {
      title: `كشف حساب ${customer.name} — ${from} إلى ${to}`,
      columns: ["المؤشر", "القيمة"],
      rows: [["الاستهلاك المعتمد م³", consumption], ["إجمالي الفواتير", billed], ["أعلى فاتورة", highest ? n(highest.total) : null], ["أقل فاتورة", lowest ? n(lowest.total) : null], ["المدفوعات المعتمدة", paid], ["الفواتير غير المسددة", unpaid.length], ["المبلغ غير المسدد", unpaidAmount], ["الرصيد الحالي", n(balance?.current_balance)]],
    },
  };
}

async function getProjectEfficiency(supabase: DB, args: Record<string, unknown>): Promise<ExtraToolResult> {
  const from = typeof args.from === "string" ? args.from : "";
  const to = typeof args.to === "string" ? args.to : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return fail("نطاق التاريخ غير صالح.");

  const [{ data: production, error: productionError }, { data: readings, error: readingsError }, { data: bills, error: billsError }, { data: payments, error: paymentsError }] = await Promise.all([
    supabase.from("production_log").select("produced_m3,logged_at").gte("logged_at", from).lte("logged_at", `${to}T23:59:59`),
    supabase.from("water_readings").select("consumption,status,reading_date").gte("reading_date", from).lte("reading_date", `${to}T23:59:59`).eq("status", "approved"),
    supabase.from("water_bills").select("total,paid_amount,issued_at").gte("issued_at", from).lte("issued_at", `${to}T23:59:59`),
    supabase.from("payments").select("amount,status,paid_at").gte("paid_at", from).lte("paid_at", `${to}T23:59:59`).eq("status", "approved"),
  ]);
  if (productionError) return fail(productionError.message);
  if (readingsError) return fail(readingsError.message);
  if (billsError) return fail(billsError.message);
  if (paymentsError) return fail(paymentsError.message);

  const produced = (production ?? []).reduce((s, p) => s + Math.max(n(p.produced_m3), 0), 0);
  const consumed = (readings ?? []).reduce((s, r) => s + Math.max(n(r.consumption), 0), 0);
  const billed = (bills ?? []).reduce((s, b) => s + n(b.total), 0);
  const collected = (payments ?? []).reduce((s, p) => s + n(p.amount), 0);
  const balanceGap = produced - consumed;
  const lossPct = produced > 0 ? Math.round((balanceGap / produced) * 1000) / 10 : null;
  const collectionPct = billed > 0 ? Math.round((collected / billed) * 1000) / 10 : 0;
  const dataQuality = balanceGap < 0 ? "تنبيه: الاستهلاك المعتمد أكبر من الإنتاج المسجل؛ راجع اكتمال بيانات الإنتاج والقراءات قبل تفسير الفاقد." : produced === 0 ? "لا يوجد إنتاج مسجل في الفترة المحددة، لذلك لا يمكن حساب نسبة الفاقد." : "الفرق الموجب مؤشر فاقد مائي ظاهري، ولا يحدد وحده سبب الفاقد.";

  return {
    ok: true,
    data: {
      period: { from, to },
      production_m3: produced,
      approved_consumption_m3: consumed,
      apparent_water_loss_m3: Math.max(balanceGap, 0),
      apparent_water_balance_gap_m3: balanceGap,
      apparent_water_loss_pct: lossPct,
      billed_amount: billed,
      collected_amount: collected,
      collection_pct: collectionPct,
      data_quality_note: dataQuality,
    },
    table: {
      title: `كفاءة المشروع — ${from} إلى ${to}`,
      columns: ["المؤشر", "القيمة"],
      rows: [["الإنتاج م³", produced], ["الاستهلاك المعتمد م³", consumed], ["الفاقد المائي الظاهري م³", Math.max(balanceGap, 0)], ["فجوة الإنتاج-الاستهلاك م³", balanceGap], ["نسبة الفاقد %", lossPct], ["المفوتر", billed], ["المحصّل", collected], ["نسبة التحصيل %", collectionPct]],
    },
  };
}
