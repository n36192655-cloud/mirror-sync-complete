import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase";

type DB = SupabaseClient<Database>;

type CustomerRow = { id: string; name: string; phone: string | null; pay_account: string | null; directorate: string | null; status: string; balance: number; created_at: string; address: string | null; family_members: number | null };
type BillRow = { id: string; bill_number: string | null; customer_id: string; issued_at: string; due_date: string | null; total: number; paid_amount: number; arrears: number; status: string; customers: { name: string; pay_account: string | null } | null };
type PaymentRow = { id: string; customer_id: string | null; amount: number; paid_at: string; method: string; status: string; customers: { name: string; pay_account: string | null } | null };
type ReadingRow = { id: string; customer_id: string; reading_date: string; current_reading: number; previous: number | null; consumption: number | null; status: string };
type MeterRow = { meters: { serial: string } | null };

const PAGE_SIZE = 1000;
const MAX_ROWS = 100_000;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
const dateOnly = (v: unknown) => (typeof v === "string" ? v.slice(0, 10) : "");
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export interface PrecisionToolResult { ok: boolean; data: unknown; table?: { title: string; columns: string[]; rows: Array<Array<string | number | null>> }; }
const fail = (error: string): PrecisionToolResult => ({ ok: false, data: { error } });

export const PRECISION_ASSISTANT_TOOLS = [
  { type: "function", function: { name: "get_customer_overview", description: "كشف حساب دقيق للمشترك: يجمع كل الفواتير والمدفوعات والقراءات المتاحة ضمن صلاحيات المستخدم بالتصفح الصفحي، ويضع complete=false إذا تجاوزت البيانات حد الأمان. الرصيد الحالي من customer_balances.", parameters: { type: "object", properties: { customer_id: { type: "string" } }, required: ["customer_id"], additionalProperties: false } } },
  { type: "function", function: { name: "list_customers", description: "قائمة مشتركين مرتبة مع total_count وcomplete؛ لا تدّعي أن القائمة كاملة إذا كانت محدودة.", parameters: { type: "object", properties: { status: { type: "string" }, directorate: { type: "string" }, min_balance: { type: "number" }, created_from: { type: "string" }, created_to: { type: "string" }, order_by: { type: "string", enum: ["balance", "name", "created_at"] }, direction: { type: "string", enum: ["asc", "desc"] }, limit: { type: "number" } }, additionalProperties: false } } },
  { type: "function", function: { name: "list_bills", description: "قائمة فواتير دقيقة حسب الفلاتر. التصفية تتم قبل حد العرض، وتعيد total_count وtotals عبر كل الصفوف المطابقة.", parameters: { type: "object", properties: { customer_id: { type: "string" }, status: { type: "string" }, unpaid_only: { type: "boolean" }, from: { type: "string" }, to: { type: "string" }, direction: { type: "string", enum: ["asc", "desc"] }, limit: { type: "number" } }, additionalProperties: false } } },
  { type: "function", function: { name: "list_payments", description: "قائمة مدفوعات دقيقة حسب الفلاتر مع total_count وtotals عبر كل الصفوف المطابقة.", parameters: { type: "object", properties: { customer_id: { type: "string" }, status: { type: "string" }, method: { type: "string" }, from: { type: "string" }, to: { type: "string" }, direction: { type: "string", enum: ["asc", "desc"] }, limit: { type: "number" } }, additionalProperties: false } } },
  { type: "function", function: { name: "list_readings", description: "قائمة قراءات دقيقة حسب الفلاتر مع total_count وconsumption_total عبر كل الصفوف المطابقة.", parameters: { type: "object", properties: { customer_id: { type: "string" }, status: { type: "string" }, from: { type: "string" }, to: { type: "string" }, direction: { type: "string", enum: ["asc", "desc"] }, limit: { type: "number" } }, additionalProperties: false } } },
] as const;

async function getBalance(supabase: DB, customerId: string) { const { data, error } = await supabase.from("customer_balances").select("current_balance").eq("customer_id", customerId).maybeSingle().returns<{ current_balance: number } | null>(); if (error) throw new Error(error.message); return data ? num(data.current_balance) : null; }
async function getCustomer(supabase: DB, customerId: string) { const { data, error } = await supabase.from("customers").select("id,name,phone,pay_account,directorate,status,balance,created_at,address,family_members").eq("id", customerId).maybeSingle().returns<CustomerRow | null>(); if (error) throw new Error(error.message); return data; }
async function getActiveMeter(supabase: DB, customerId: string) { const { data } = await supabase.from("meter_assignments").select("meters(serial)").eq("customer_id", customerId).is("ended_at", null).limit(1).returns<MeterRow[]>(); return data?.[0]?.meters?.serial ?? ""; }

async function allBills(supabase: DB, customerId: string) { const rows: BillRow[] = []; for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) { const { data, error } = await supabase.from("water_bills").select("id,bill_number,customer_id,issued_at,due_date,total,paid_amount,arrears,status,customers(name,pay_account)").eq("customer_id", customerId).order("issued_at", { ascending: false }).range(offset, offset + PAGE_SIZE - 1).returns<BillRow[]>(); if (error) return { rows, complete: false, error: error.message }; rows.push(...(data ?? [])); if ((data ?? []).length < PAGE_SIZE) return { rows, complete: true }; } return { rows, complete: false, error: "تجاوز عدد الفواتير حد القراءة الآمن؛ لم أعتبر الإجماليات مكتملة." }; }
async function allPayments(supabase: DB, customerId: string) { const rows: PaymentRow[] = []; for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) { const { data, error } = await supabase.from("payments").select("id,customer_id,amount,paid_at,method,status,customers(name,pay_account)").eq("customer_id", customerId).order("paid_at", { ascending: false }).range(offset, offset + PAGE_SIZE - 1).returns<PaymentRow[]>(); if (error) return { rows, complete: false, error: error.message }; rows.push(...(data ?? [])); if ((data ?? []).length < PAGE_SIZE) return { rows, complete: true }; } return { rows, complete: false, error: "تجاوز عدد المدفوعات حد القراءة الآمن؛ لم أعتبر الإجماليات مكتملة." }; }
async function allReadings(supabase: DB, customerId: string) { const rows: ReadingRow[] = []; for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) { const { data, error } = await supabase.from("water_readings").select("id,customer_id,reading_date,current_reading,previous,consumption,status").eq("customer_id", customerId).order("reading_date", { ascending: false }).range(offset, offset + PAGE_SIZE - 1).returns<ReadingRow[]>(); if (error) return { rows, complete: false, error: error.message }; rows.push(...(data ?? [])); if ((data ?? []).length < PAGE_SIZE) return { rows, complete: true }; } return { rows, complete: false, error: "تجاوز عدد القراءات حد القراءة الآمن؛ لم أعتبر إجماليات الاستهلاك مكتملة." }; }

export async function runPrecisionAssistantTool(supabase: DB, name: string, args: Record<string, unknown>): Promise<PrecisionToolResult> { try { switch (name) { case "get_customer_overview": return overview(supabase, args); case "list_customers": return customers(supabase, args); case "list_bills": return bills(supabase, args); case "list_payments": return payments(supabase, args); case "list_readings": return readings(supabase, args); default: return fail("أداة دقيقة غير معروفة."); } } catch (error) { return fail(error instanceof Error ? error.message : "تعذر تنفيذ الاستعلام."); } }

async function overview(supabase: DB, args: Record<string, unknown>): Promise<PrecisionToolResult> {
  const customerId = args.customer_id; if (!isUuid(customerId)) return fail("customer_id غير صالح.");
  const [customer, balance, meter, bills, payments, readings] = await Promise.all([getCustomer(supabase, customerId), getBalance(supabase, customerId), getActiveMeter(supabase, customerId), allBills(supabase, customerId), allPayments(supabase, customerId), allReadings(supabase, customerId)]);
  if (!customer) return { ok: true, data: { found: false } };
  const approvedPayments = payments.rows.filter((p) => p.status === "approved");
  const approvedReadings = readings.rows.filter((r) => r.status === "approved");
  const billed = bills.rows.reduce((s, b) => s + num(b.total), 0);
  const paid = approvedPayments.reduce((s, p) => s + num(p.amount), 0);
  const outstanding = bills.rows.reduce((s, b) => s + Math.max(0, num(b.total) - num(b.paid_amount)), 0);
  const consumption = approvedReadings.reduce((s, r) => s + num(r.consumption), 0);
  const complete = bills.complete && payments.complete && readings.complete;
  return { ok: true, data: { found: true, complete, completeness: { bills: bills.complete, payments: payments.complete, readings: readings.complete }, customer: { id: customer.id, name: customer.name, phone: customer.phone ?? "", pay_account: customer.pay_account ?? "", directorate: customer.directorate ?? "", status: customer.status, meter_serial: meter, address: customer.address ?? "", family_members: customer.family_members ?? null }, balance_source: "customer_balances.current_balance", current_balance: balance, totals: { billed, paid, outstanding_from_bills: outstanding, bills_count: bills.rows.length, unpaid_bills_count: bills.rows.filter((b) => num(b.total) - num(b.paid_amount) > 0.01).length, payments_count: approvedPayments.length, readings_count: approvedReadings.length, consumption_approved_readings: consumption, collection_pct: billed > 0 ? Math.round((paid / billed) * 10000) / 100 : 0 }, last_bill: bills.rows[0] ? { bill_number: bills.rows[0].bill_number, issued_at: dateOnly(bills.rows[0].issued_at), due_date: dateOnly(bills.rows[0].due_date), total: num(bills.rows[0].total), paid_amount: num(bills.rows[0].paid_amount), remaining: Math.max(0, num(bills.rows[0].total) - num(bills.rows[0].paid_amount)), status: bills.rows[0].status } : null, last_payment: approvedPayments[0] ? { date: dateOnly(approvedPayments[0].paid_at), amount: num(approvedPayments[0].amount), method: approvedPayments[0].method } : null, last_reading: approvedReadings[0] ? { date: dateOnly(approvedReadings[0].reading_date), current: num(approvedReadings[0].current_reading), previous: approvedReadings[0].previous == null ? null : num(approvedReadings[0].previous), consumption: approvedReadings[0].consumption == null ? null : num(approvedReadings[0].consumption), status: approvedReadings[0].status } : null, recent_bills: bills.rows.slice(0, 6).map((b) => ({ bill_number: b.bill_number, date: dateOnly(b.issued_at), total: num(b.total), paid: num(b.paid_amount), status: b.status })), recent_payments: approvedPayments.slice(0, 6).map((p) => ({ date: dateOnly(p.paid_at), amount: num(p.amount), method: p.method })), recent_readings: approvedReadings.slice(0, 6).map((r) => ({ date: dateOnly(r.reading_date), current: num(r.current_reading), consumption: r.consumption == null ? null : num(r.consumption), status: r.status })), incomplete_reason: complete ? null : "بعض مجموعات البيانات لم تصل إلى نهاية القراءة الصفحية، لذلك لا يجوز استخدام الإجماليات كإجماليات مؤكدة." }, table: { title: `كشف حساب: ${customer.name}`, columns: ["البند", "القيمة"], rows: [["الرصيد الحالي", balance], ["إجمالي المفوتر", complete ? billed : null], ["إجمالي المدفوع المعتمد", complete ? paid : null], ["المتبقي من الفواتير", complete ? outstanding : null], ["الاستهلاك من القراءات المعتمدة", complete ? consumption : null], ["حالة اكتمال البيانات", complete ? "مكتملة" : "غير مكتملة"]] } };
}

async function customers(supabase: DB, args: Record<string, unknown>): Promise<PrecisionToolResult> {
  const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 200);
  let q = supabase.from("customers").select("id,name,phone,pay_account,directorate,status,balance,created_at", { count: "exact" });
  if (typeof args.status === "string" && args.status) q = q.eq("status", args.status);
  if (typeof args.directorate === "string" && args.directorate) q = q.ilike("directorate", `%${args.directorate}%`);
  if (typeof args.min_balance === "number") q = q.gte("balance", args.min_balance);
  if (typeof args.created_from === "string") q = q.gte("created_at", args.created_from);
  if (typeof args.created_to === "string") q = q.lte("created_at", `${args.created_to}T23:59:59`);
  const order = ["balance", "name", "created_at"].includes(String(args.order_by)) ? String(args.order_by) : "created_at";
  const asc = args.direction === "asc";
  const { data, error, count } = await q.order(order, { ascending: asc }).limit(limit).returns<CustomerRow[]>();
  if (error) return fail(error.message);
  const list = data ?? [];
  return { ok: true, data: { customers: list, returned_count: list.length, total_count: count ?? null, complete: (count ?? list.length) <= list.length }, table: list.length ? { title: "قائمة المشتركين", columns: ["الاسم", "رقم الحساب", "الهاتف", "المديرية", "الحالة", "الرصيد"], rows: list.map((c) => [c.name, c.pay_account ?? "", c.phone ?? "", c.directorate ?? "", c.status, num(c.balance)]) } : undefined };
}

async function bills(supabase: DB, args: Record<string, unknown>): Promise<PrecisionToolResult> {
  const customerId = args.customer_id; if (customerId !== undefined && !isUuid(customerId)) return fail("customer_id غير صالح.");
  let q = supabase.from("water_bills").select("id,bill_number,customer_id,issued_at,due_date,total,paid_amount,arrears,status,customers(name,pay_account)");
  if (isUuid(customerId)) q = q.eq("customer_id", customerId);
  if (typeof args.status === "string" && args.status) q = q.eq("status", args.status);
  if (typeof args.from === "string") q = q.gte("issued_at", args.from);
  if (typeof args.to === "string") q = q.lte("issued_at", `${args.to}T23:59:59`);
  const asc = args.direction === "asc"; const rows: BillRow[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) { const { data, error } = await q.order("issued_at", { ascending: asc }).range(offset, offset + PAGE_SIZE - 1).returns<BillRow[]>(); if (error) return fail(error.message); rows.push(...(data ?? [])); if ((data ?? []).length < PAGE_SIZE) break; if (offset + PAGE_SIZE >= MAX_ROWS) return fail("تجاوزت البيانات حد القراءة الآمن؛ لم أعتبر القائمة أو الإجماليات كاملة."); }
  const filtered = args.unpaid_only === true ? rows.filter((b) => num(b.total) - num(b.paid_amount) > 0.01) : rows;
  const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 200);
  const list = filtered.slice(0, limit).map((b) => ({ bill_number: b.bill_number ?? "", customer_id: b.customer_id, customer_name: b.customers?.name ?? "", issued_at: dateOnly(b.issued_at), due_date: dateOnly(b.due_date), total: num(b.total), paid_amount: num(b.paid_amount), remaining: Math.max(0, num(b.total) - num(b.paid_amount)), status: b.status }));
  return { ok: true, data: { bills: list, returned_count: list.length, total_count: filtered.length, complete: rows.length < MAX_ROWS, total_amount: filtered.reduce((s, b) => s + num(b.total), 0), total_remaining: filtered.reduce((s, b) => s + Math.max(0, num(b.total) - num(b.paid_amount)), 0) }, table: list.length ? { title: "الفواتير", columns: ["رقم الفاتورة", "المشترك", "التاريخ", "الإجمالي", "المسدد", "المتبقي", "الحالة"], rows: list.map((b) => [b.bill_number, b.customer_name, b.issued_at, b.total, b.paid_amount, b.remaining, b.status]) } : undefined };
}

async function payments(supabase: DB, args: Record<string, unknown>): Promise<PrecisionToolResult> {
  const customerId = args.customer_id; if (customerId !== undefined && !isUuid(customerId)) return fail("customer_id غير صالح.");
  let q = supabase.from("payments").select("id,customer_id,amount,paid_at,method,status,customers(name,pay_account)");
  if (isUuid(customerId)) q = q.eq("customer_id", customerId);
  if (typeof args.status === "string" && args.status) q = q.eq("status", args.status);
  if (typeof args.method === "string" && args.method) q = q.eq("method", args.method);
  if (typeof args.from === "string") q = q.gte("paid_at", args.from);
  if (typeof args.to === "string") q = q.lte("paid_at", `${args.to}T23:59:59`);
  const asc = args.direction === "asc"; const rows: PaymentRow[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) { const { data, error } = await q.order("paid_at", { ascending: asc }).range(offset, offset + PAGE_SIZE - 1).returns<PaymentRow[]>(); if (error) return fail(error.message); rows.push(...(data ?? [])); if ((data ?? []).length < PAGE_SIZE) break; if (offset + PAGE_SIZE >= MAX_ROWS) return fail("تجاوزت البيانات حد القراءة الآمن؛ لم أعتبر القائمة أو الإجماليات كاملة."); }
  const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 200); const list = rows.slice(0, limit).map((p) => ({ customer_id: p.customer_id, customer_name: p.customers?.name ?? "", date: dateOnly(p.paid_at), amount: num(p.amount), method: p.method, status: p.status }));
  return { ok: true, data: { payments: list, returned_count: list.length, total_count: rows.length, complete: rows.length < MAX_ROWS, total_amount: rows.reduce((s, p) => s + num(p.amount), 0), approved_total: rows.filter((p) => p.status === "approved").reduce((s, p) => s + num(p.amount), 0) }, table: list.length ? { title: "المدفوعات", columns: ["المشترك", "التاريخ", "المبلغ", "الطريقة", "الحالة"], rows: list.map((p) => [p.customer_name, p.date, p.amount, p.method, p.status]) } : undefined };
}

async function readings(supabase: DB, args: Record<string, unknown>): Promise<PrecisionToolResult> {
  const customerId = args.customer_id; if (customerId !== undefined && !isUuid(customerId)) return fail("customer_id غير صالح.");
  let q = supabase.from("water_readings").select("id,customer_id,reading_date,current_reading,previous,consumption,status");
  if (isUuid(customerId)) q = q.eq("customer_id", customerId);
  if (typeof args.status === "string" && args.status) q = q.eq("status", args.status);
  if (typeof args.from === "string") q = q.gte("reading_date", args.from);
  if (typeof args.to === "string") q = q.lte("reading_date", args.to);
  const asc = args.direction === "asc"; const rows: ReadingRow[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) { const { data, error } = await q.order("reading_date", { ascending: asc }).range(offset, offset + PAGE_SIZE - 1).returns<ReadingRow[]>(); if (error) return fail(error.message); rows.push(...(data ?? [])); if ((data ?? []).length < PAGE_SIZE) break; if (offset + PAGE_SIZE >= MAX_ROWS) return fail("تجاوزت البيانات حد القراءة الآمن؛ لم أعتبر القائمة أو الإجماليات كاملة."); }
  const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 200); const list = rows.slice(0, limit).map((r) => ({ customer_id: r.customer_id, date: dateOnly(r.reading_date), current: num(r.current_reading), previous: r.previous == null ? null : num(r.previous), consumption: r.consumption == null ? null : num(r.consumption), status: r.status }));
  return { ok: true, data: { readings: list, returned_count: list.length, total_count: rows.length, complete: rows.length < MAX_ROWS, consumption_total: rows.reduce((s, r) => s + num(r.consumption), 0), approved_consumption_total: rows.filter((r) => r.status === "approved").reduce((s, r) => s + num(r.consumption), 0) }, table: list.length ? { title: "قراءات العدادات", columns: ["التاريخ", "الحالي", "السابق", "الاستهلاك", "الحالة"], rows: list.map((r) => [r.date, r.current, r.previous, r.consumption, r.status]) } : undefined };
}
