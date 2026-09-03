import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface AssistantTable { title: string; columns: string[]; rows: Array<Array<string | number | null>>; }
export interface AssistantTurn { role: "user" | "assistant"; content: string; }
export interface AssistantAnswer { answer: string; tables: AssistantTable[]; tools: string[]; suggestions: string[]; }
interface AskInput { question: string; history?: AssistantTurn[]; }
function validateAsk(input: unknown): AskInput {
  const obj = (input ?? {}) as Record<string, unknown>;
  const question = typeof obj.question === "string" ? obj.question.trim() : "";
  if (!question) throw new Error("السؤال فارغ");
  if (question.length > 1000) throw new Error("السؤال طويل جداً");
  const rawHistory = Array.isArray(obj.history) ? obj.history : [];
  const history: AssistantTurn[] = rawHistory.slice(-8).map((t) => t as Record<string, unknown>).filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.content === "string").map((t) => ({ role: t.role as "user" | "assistant", content: String(t.content).slice(0, 2000) }));
  return { question, history };
}
const yemenToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Aden", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export const askAssistant = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator(validateAsk).handler(async ({ data, context }): Promise<AssistantAnswer> => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("خدمة الذكاء الاصطناعي غير مهيأة (GEMINI_API_KEY مفقود).");
  const { ASSISTANT_TOOLS, runAssistantTool } = await import("./assistant/tools.server");
  const { EXTRA_ASSISTANT_TOOLS, runExtraAssistantTool } = await import("./assistant/extra-tools.server");
  const { geminiChat, GeminiError } = await import("./gemini.server");
  const today = yemenToday();
  const system = `أنت «ميزان الذكي»، مساعد تحليلي تشغيلي لمنصة إدارة مياه. مهمتك الإجابة من بيانات Supabase الحية ضمن صلاحيات المستخدم، لا من الذاكرة ولا من التخمين.

التاريخ المحلي التشغيلي: ${today}. العملة: الريال اليمني. وحدة المياه: متر مكعب (م³).

مبادئ الدقة:
1. ممنوع اختراع أي رقم أو اسم أو تاريخ أو حالة. كل حقيقة رقمية يجب أن تأتي من أداة نفذتها الآن.
2. لا تستخدم بيانات الواجهة المحلية كمصدر حقيقة؛ الأدوات الخادمية وقاعدة البيانات هي المصدر.
3. للمشترك المحدد: ابدأ بـ search_customers. إذا وجدت أكثر من تطابق، لا تختار واحداً من نفسك ولا تستدعِ أي أداة تفاصيل؛ انتظر اختيار المستخدم.
4. إذا لم تجد مشتركاً، صرّح بذلك ولا تعرض بيانات مشترك آخر.
5. لأسئلة الشهر/السنة/الفترة عن مشترك، استخدم get_customer_period_summary بعد الحصول على UUID. لا تجمع «آخر القراءات» بدلاً من الفترة المطلوبة.
6. لأسئلة أعلى/أقل فاتورة استخدم get_customer_period_summary للفترة المحددة أو list_bills إذا كان السؤال عاماً.
7. عند طلب الفواتير غير المسددة، استخدم list_unpaid_bills بدلاً من list_bills مع unpaid_only؛ الأداة الجديدة تفحص النتائج قبل تطبيق حد العرض.
8. المدفوعات المالية المعتمدة فقط هي status=approved. الفواتير غير المسددة تُحسب من المتبقي الفعلي، ولا تعتبر الفاتورة مدفوعة لمجرد وجود دفعة معلقة.
9. الرصيد الحالي مصدره customer_balances.current_balance.
10. للاستهلاك التحليلي استخدم القراءات المعتمدة فقط. لا تخلط pending/rejected في إجمالي الاستهلاك.
11. لكفاءة المشروع والهدر/الفاقد استخدم get_project_efficiency. المؤشر الناتج هو فجوة الإنتاج المسجل والاستهلاك المعتمد، وليس تصنيفاً مؤكداً لـNRW أو apparent loss أو leakage. لا تدّعِ سبب الفجوة من هذا المؤشر وحده.
12. نسبة التحصيل في أدوات الفترة تعني: المدفوعات المعتمدة داخل الفترة ÷ مفوتر الفترة نفسها. قد تتجاوز 100% إذا كانت التحصيلات تشمل فواتير من فترات سابقة؛ لا تسمّها معدل تحصيل الذمم الافتتاحية.
13. «هذا الشهر» = من أول يوم في الشهر المحلي إلى آخر يوم حتى اليوم. «الشهر الماضي» = الشهر الميلادي السابق كاملاً. «هذه السنة» = من 1 يناير إلى اليوم. «سنة 2025» = 2025-01-01 إلى 2025-12-31. «من X إلى Y» يحترم التاريخين كما هما.
14. افهم العربية الطبيعية والمرادفات والأخطاء البسيطة، وحوّل الفترات إلى YYYY-MM-DD.
15. إذا كان السؤال غامضاً لكن توجد احتمالات منطقية داخل النظام، لا تخمّن: اعرض خيارات قصيرة قابلة للنقر عبر [اقتراحات].
16. الاقتراحات يجب أن تكون مرتبطة بالسؤال الحالي فقط، بحد أقصى 4، ومكتوبة كسؤال كامل يمكن إرساله كما هو.
17. أجب باختصار مهني، مع ملخص واضح ثم التفاصيل اللازمة. لا تكرر الجداول لأن الواجهة تعرضها تلقائياً.
18. لا تنفذ أي تغيير في البيانات؛ هذا المساعد للقراءة والتحليل فقط.

في النهاية أضف دائماً: [اقتراحات] سؤال1 | سؤال2 | سؤال3`;
  type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
  interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; }
  const messages: ChatMessage[] = [{ role: "system", content: system }, ...(data.history ?? []).map((t) => ({ role: t.role, content: t.content })), { role: "user", content: data.question }];
  const tables: AssistantTable[] = [];
  const usedTools: string[] = [];
  const allTools = [...ASSISTANT_TOOLS, ...EXTRA_ASSISTANT_TOOLS];
  const extraToolNames = new Set(EXTRA_ASSISTANT_TOOLS.map((tool) => tool.function.name));
  for (let step = 0; step < 6; step++) {
    let payload: { choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }> };
    try { payload = (await geminiChat(apiKey, { messages, tools: allTools, temperature: 0.1 })) as typeof payload; }
    catch (err) { const status = err instanceof GeminiError ? err.status : 0; if (status === 429) throw new Error("تم تجاوز حد الاستخدام مؤقتاً، أعد المحاولة بعد قليل."); if (status === 402) throw new Error("رصيد خدمة الذكاء الاصطناعي غير كافٍ."); throw new Error("تعذّر الوصول إلى محرك الذكاء الاصطناعي."); }
    const msg = payload.choices?.[0]?.message;
    if (!msg) throw new Error("استجابة غير متوقعة من محرك الذكاء الاصطناعي.");
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      const raw = (msg.content ?? "").trim(); const suggestions: string[] = []; let answer = raw;
      const match = raw.match(/\[اقتراحات\]([^\n]*)$/m);
      if (match) { answer = raw.replace(match[0], "").trim(); suggestions.push(...(match[1] ?? "").split("|").map((s) => s.trim()).filter(Boolean).slice(0, 4)); }
      return { answer: answer || "لم أتمكن من صياغة إجابة.", tables, tools: usedTools, suggestions };
    }
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>; } catch { args = {}; }
      usedTools.push(call.function.name);
      let result;
      try { result = extraToolNames.has(call.function.name) ? await runExtraAssistantTool(context.supabase, call.function.name, args) : await runAssistantTool(context.supabase, call.function.name, args); }
      catch (err) { console.error("[assistant] tool failed", call.function.name, err); result = { ok: false, data: { error: "تعذر تنفيذ الاستعلام." } }; }
      if (result.table && result.table.rows.length > 0) tables.push(result.table);
      if (call.function.name === "search_customers") {
        const dataResult = result.data as { found?: boolean; count?: number; matches?: Array<{ name?: string; pay_account?: string; meter_serial?: string }> };
        if (dataResult.found === false) return { answer: "لم أعثر على مشترك مطابق لهذا البحث. لن أعرض بيانات مشترك آخر. جرّب رقم الحساب أو الهاتف أو رقم العداد أو اكتب الاسم بشكل أوضح.", tables, tools: usedTools, suggestions: ["ابحث برقم الحساب", "ابحث برقم الهاتف", "ابحث برقم العداد"] };
        if ((dataResult.count ?? 0) > 1) {
          const suggestions = (dataResult.matches ?? []).slice(0, 4).map((m) => { const account = m.pay_account ? ` — حساب ${m.pay_account}` : ""; return `اعرض كشف حساب ${m.name ?? "هذا المشترك"}${account}`; });
          return { answer: "وجدت أكثر من مشترك مطابق. اختر المشترك المقصود من الأزرار أدناه، ولن أعرض تفاصيل مالية قبل تحديد الهوية.", tables, tools: usedTools, suggestions };
        }
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result.data).slice(0, 60000) });
    }
  }
  return { answer: "لم أتمكن من إكمال التحليل ضمن الحد الآمن للخطوات. جرّب تقسيم السؤال إلى جزءين.", tables, tools: usedTools, suggestions: ["كشف حساب هذا المشترك", "أعلى فاتورة في الفترة", "المدفوعات في الفترة"] };
});
