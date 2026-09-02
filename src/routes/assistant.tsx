import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Database, Droplets, Gauge, Send, User, Loader2, Wallet } from "lucide-react";
import { askAssistant, type AssistantTable, type AssistantTurn } from "@/lib/assistant.functions";
import { AssistantAnswerView } from "@/components/assistant-answer";
import { MizanAiIcon } from "@/components/mizan-ai-icon";
import { toast } from "sonner";

export const Route = createFileRoute("/assistant")({
  head: () => ({
    meta: [
      { title: "ميزان الذكي — مساعد تحليل بيانات المياه" },
      { name: "description", content: "مساعد ذكي يجيب بالعربية عن المشتركين والعدادات والفواتير والمدفوعات والمتأخرات والتحصيل من أحدث بيانات المنصة." },
      { property: "og:title", content: "ميزان الذكي — مساعد تحليل بيانات المياه" },
      { property: "og:description", content: "اسأل بالعربية الطبيعية عن أي مشترك أو مؤشر تشغيلي واحصل على إجابة مبنية على بيانات القاعدة مباشرة." },
    ],
  }),
  component: AssistantPage,
});

interface UserMsg { role: "user"; text: string }
interface AssistantMsg { role: "assistant"; text: string; tables: AssistantTable[] }
type Msg = UserMsg | AssistantMsg;

const DEFAULT_SUGGESTIONS = [
  "كشف حساب المشترك أحمد لهذا الشهر",
  "من عليه أكبر مديونية؟",
  "كم حصّلنا هذا الشهر؟",
  "أعلى ٥ مشتركين استهلاكاً هذا العام",
  "كم الفاقد هذا الشهر؟",
  "الفواتير غير المسددة هذا الشهر",
];

const WELCOME =
  "أهلاً بك في «ميزان الذكي». أستطيع الاستعلام من قاعدة البيانات الحية ضمن صلاحياتك عن أي مشترك أو عداد أو فاتورة أو دفعة، وحساب الاستهلاك والفواتير والمدفوعات والأرصدة لفترة محددة، إضافةً إلى مؤشرات كفاءة المشروع والفاقد المائي. إذا كان السؤال يحتمل أكثر من مشترك، سأطلب منك الاختيار بدلاً من التخمين.";

const CAPABILITIES = [
  { label: "المشتركون والحسابات", icon: User },
  { label: "الفواتير والمدفوعات", icon: Wallet },
  { label: "الاستهلاك والعدادات", icon: Gauge },
  { label: "الكفاءة والفاقد", icon: Droplets },
];

function AssistantPage() {
  const ask = useServerFn(askAssistant);
  const [messages, setMessages] = useState<Msg[]>([{ role: "assistant", text: WELCOME, tables: [] }]);
  const [suggestions, setSuggestions] = useState<string[]>(DEFAULT_SUGGESTIONS);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    const history: AssistantTurn[] = messages
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.text }));

    setMessages((m) => [...m, { role: "user", text: question }]);
    setInput("");
    setBusy(true);
    try {
      const res = await ask({ data: { question, history } });
      setMessages((m) => [...m, { role: "assistant", text: res.answer, tables: res.tables }]);
      setSuggestions(res.suggestions.length > 0 ? res.suggestions : DEFAULT_SUGGESTIONS);
    } catch (err) {
      const message = err instanceof Error ? err.message : "تعذّر تنفيذ الطلب";
      toast.error(message);
      setMessages((m) => [...m, { role: "assistant", text: `تعذّر تنفيذ الطلب: ${message}`, tables: [] }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4" dir="rtl">
      <div className="rounded-2xl border bg-gradient-to-br from-primary/10 via-background to-background p-4 md:p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
              <MizanAiIcon size={34} /> ميزان الذكي
            </h1>
            <p className="text-sm text-muted-foreground mt-2 max-w-3xl">
              مساعد تحليلي يفهم العربية الطبيعية ويستعلم من قاعدة البيانات الحية ضمن صلاحياتك، مع منع التخمين عند غموض هوية المشترك.
            </p>
          </div>
          <div className="hidden sm:flex items-center gap-2 rounded-full border bg-background/80 px-3 py-1.5 text-xs font-medium">
            <Database className="h-3.5 w-3.5 text-emerald-600" /> بيانات حية
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {CAPABILITIES.map(({ label, icon: Icon }) => (
            <span key={label} className="inline-flex items-center gap-1.5 rounded-full bg-background/80 border px-2.5 py-1 text-xs text-muted-foreground">
              <Icon className="h-3.5 w-3.5" /> {label}
            </span>
          ))}
        </div>
      </div>

      <Card className="flex flex-col h-[72vh] overflow-hidden shadow-sm">
        <CardHeader className="border-b py-3 bg-muted/20">
          <CardTitle className="text-sm flex items-center gap-2">
            <MizanAiIcon size={20} /> مستشار ميزان الرقمي
            <span className="mr-auto text-[11px] font-normal text-muted-foreground">قراءة وتحليل فقط</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((m, i) => (
            <div key={i} className={`flex gap-2 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
              <div
                className={`w-9 h-9 rounded-full grid place-items-center shrink-0 border ${
                  m.role === "user" ? "bg-primary text-primary-foreground border-primary" : "bg-background"
                }`}
                aria-hidden="true"
              >
                {m.role === "user" ? <User className="w-4 h-4" /> : <MizanAiIcon size={21} />}
              </div>
              <div
                className={
                  m.role === "user"
                    ? "max-w-[90%] rounded-2xl rounded-tr-md px-3.5 py-2.5 text-sm bg-primary text-primary-foreground shadow-sm"
                    : "flex-1 max-w-[92%]"
                }
              >
                {m.role === "user" ? m.text : <AssistantAnswerView answer={m.text} tables={m.tables} />}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex gap-2 items-center text-sm text-muted-foreground">
              <div className="w-9 h-9 rounded-full grid place-items-center border bg-background">
                <MizanAiIcon size={21} />
              </div>
              <div className="rounded-2xl border bg-muted/30 px-3 py-2 inline-flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> يتحقق من البيانات ويحللها…
              </div>
            </div>
          )}
        </CardContent>
        <div className="border-t p-3 space-y-2 bg-background">
          <div className="flex flex-wrap gap-2" aria-label="أسئلة مقترحة">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                disabled={busy}
                onClick={() => void send(s)}
                className="text-xs px-3 py-1.5 rounded-full border bg-background hover:bg-primary/10 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-colors disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="مثال: احسب استهلاك المشترك أحمد في أغسطس 2026…"
              aria-label="اكتب سؤالك لميزان الذكي"
              disabled={busy}
            />
            <Button type="submit" size="icon" aria-label="إرسال السؤال" disabled={busy || !input.trim()}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
