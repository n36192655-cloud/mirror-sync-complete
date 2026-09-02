import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Calculator, CircleDollarSign, Cloud, Database, Gauge, Settings2, ShieldCheck, TrendingUp, Wallet, Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/costs")({
  head: () => ({ meta: [{ title: "التكلفة والاستدامة — ميزان" }] }),
  component: CostsPage,
});

type CostConfig = {
  vercelPro: number;
  supabasePro: number;
  supabaseComputeCredit: number;
  vercelUsageCredit: number;
  aiPer5000: number;
  storagePer5000: number;
  margin: number;
  pricePerMeter: number;
};

const DEFAULT_CONFIG: CostConfig = {
  vercelPro: 20,
  supabasePro: 25,
  supabaseComputeCredit: 10,
  vercelUsageCredit: 20,
  aiPer5000: 0,
  storagePer5000: 0,
  margin: 75,
  // سعر خدمة افتراضي يحقق 75% هامشًا تقريبًا عند 5,000 عداد إذا كانت التكلفة الأساسية $45.
  pricePerMeter: 0.036,
};

const STORAGE_KEY = "mizan-cost-config-v3";

function money(value: number) {
  return `$${value.toFixed(2)}`;
}

function moneyPrecise(value: number) {
  return `$${value.toFixed(4)}`;
}

function number(value: number) {
  return new Intl.NumberFormat("ar-YE", { maximumFractionDigits: 2 }).format(value);
}

function readConfig(): CostConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return DEFAULT_CONFIG;
    const parsed = JSON.parse(saved) as Partial<CostConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function MetricCard({ label, value, hint, icon, tone = "neutral" }: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ReactNode;
  tone?: "neutral" | "positive" | "negative";
}) {
  const toneClass = tone === "positive"
    ? "border-emerald-200 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/30"
    : tone === "negative"
      ? "border-red-200 bg-red-50/70 dark:border-red-900 dark:bg-red-950/30"
      : "border-border bg-card";
  const valueClass = tone === "positive"
    ? "text-emerald-700 dark:text-emerald-400"
    : tone === "negative"
      ? "text-red-700 dark:text-red-400"
      : "text-foreground";

  return (
    <Card className={`overflow-hidden ${toneClass}`}>
      <CardContent className="p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-muted-foreground">{label}</div>
          <div className="rounded-xl bg-background/80 p-2.5 shadow-sm">{icon}</div>
        </div>
        <div className={`mt-3 text-2xl font-black ${valueClass}`}>{value}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function CostsPage() {
  const { user } = useAuth();
  const [config, setConfig] = useState<CostConfig>(readConfig);
  const [meters, setMeters] = useState("5000");
  const [projects, setProjects] = useState("10");
  const [metersPerProject, setMetersPerProject] = useState("1000");

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }, [config]);

  const meterCount = Math.max(0, Number(meters) || 0);
  const projectCount = Math.max(0, Number(projects) || 0);
  const perProject = Math.max(0, Number(metersPerProject) || 0);

  const projectCost = useMemo(() => {
    const scale = meterCount / 5000;
    const ai = config.aiPer5000 * scale;
    const storage = config.storagePer5000 * scale;
    const hosting = config.vercelPro + config.supabasePro;
    const total = hosting + ai + storage;
    const monthlyRevenue = config.pricePerMeter * meterCount;
    const monthlyProfit = monthlyRevenue - total;
    const annualRevenue = monthlyRevenue * 12;
    const annualCost = total * 12;
    const annualProfit = monthlyProfit * 12;
    const effectiveMargin = monthlyRevenue > 0 ? (monthlyProfit / monthlyRevenue) * 100 : 0;
    const suggestedPricePerMeter = meterCount > 0
      ? total / meterCount / Math.max(0.01, 1 - config.margin / 100)
      : 0;
    const suggestedProjectPrice = suggestedPricePerMeter * meterCount;
    return {
      ai,
      storage,
      hosting,
      total,
      suggestedPricePerMeter,
      suggestedProjectPrice,
      monthlyRevenue,
      monthlyProfit,
      annualRevenue,
      annualCost,
      annualProfit,
      effectiveMargin,
      perMeterCost: meterCount ? total / meterCount : 0,
    };
  }, [config, meterCount]);

  // هذا الرسم يفترض مشروعًا واحدًا؛ عدد المشاريع المنفصل يعالج في محاكي التوسع أدناه.
  const scaleData = useMemo(() => [300, 1000, 5000, 10000, 20000].map((count) => {
    const scale = count / 5000;
    const cost = config.vercelPro + config.supabasePro + (config.aiPer5000 + config.storagePer5000) * scale;
    const revenue = config.pricePerMeter * count;
    return {
      meters: count,
      cost: Number(cost.toFixed(2)),
      profit: Number((revenue - cost).toFixed(2)),
    };
  }), [config]);

  const scenarioMeters = projectCount * perProject;
  const scenario = useMemo(() => {
    const scale = scenarioMeters / 5000;
    // Vercel منصة مشتركة، بينما Supabase يفرض Compute مستقلًا لكل Project.
    const cost = config.vercelPro + (config.supabasePro * projectCount) + (config.aiPer5000 + config.storagePer5000) * scale;
    const revenue = config.pricePerMeter * scenarioMeters;
    const profit = revenue - cost;
    const annualProfit = profit * 12;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
    return { cost, revenue, profit, annualProfit, margin };
  }, [config, projectCount, scenarioMeters]);

  function update<K extends keyof CostConfig>(key: K, value: string) {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    setConfig((current) => ({ ...current, [key]: n }));
  }

  function resetConfig() {
    setConfig(DEFAULT_CONFIG);
  }

  const profitPositive = projectCost.monthlyProfit >= 0;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-gradient-to-br from-primary/10 via-card to-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-primary/10 p-3"><Calculator className="h-6 w-6 text-primary" /></div>
            <div>
              <h1 className="text-2xl font-black tracking-tight md:text-3xl">التكلفة والاستدامة</h1>
              <p className="mt-1 text-sm text-muted-foreground">نموذج مالي تشغيلي مبني على أسعار الاستضافة الرسمية وقابل للتعديل.</p>
            </div>
          </div>
          <Badge className="w-fit px-3 py-1.5" variant="secondary">أسعار رسمية • USD / شهر</Badge>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="الإيراد الشهري" value={money(projectCost.monthlyRevenue)} hint="سعر الخدمة × عدد العدادات" icon={<Wallet className="h-4 w-4" />} tone="positive" />
        <MetricCard label="التكلفة الشهرية" value={money(projectCost.total)} hint="Vercel + Supabase + استخدام زائد" icon={<Cloud className="h-4 w-4" />} />
        <MetricCard label="الربح الشهري" value={money(projectCost.monthlyProfit)} hint={`الهامش الفعلي ${projectCost.effectiveMargin.toFixed(1)}%`} icon={<CircleDollarSign className="h-4 w-4" />} tone={profitPositive ? "positive" : "negative"} />
        <MetricCard label="الربح السنوي" value={money(projectCost.annualProfit)} hint="الربح الشهري × 12" icon={<TrendingUp className="h-4 w-4" />} tone={profitPositive ? "positive" : "negative"} />
      </div>

      <Card className="shadow-sm">
        <CardHeader><CardTitle className="text-base font-bold">1. البنية التحتية الفعلية — Infrastructure</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-2xl border bg-card p-4">
              <div className="flex items-center gap-2 font-bold"><Cloud className="h-4 w-4 text-primary" /> Vercel Pro — استضافة ونشر التطبيق</div>
              <div className="mt-2 text-2xl font-black">{money(config.vercelPro)} <span className="text-xs font-normal text-muted-foreground">/ شهر</span></div>
              <p className="mt-1 text-xs text-muted-foreground">اشتراك Pro الأساسي. أي استخدام مدفوع إضافي يُحسب حسب الاستهلاك.</p>
            </div>
            <div className="rounded-2xl border bg-card p-4">
              <div className="flex items-center gap-2 font-bold"><Database className="h-4 w-4 text-primary" /> Supabase Pro — قاعدة البيانات والخدمات الخلفية</div>
              <div className="mt-2 text-2xl font-black">{money(config.supabasePro)} <span className="text-xs font-normal text-muted-foreground">/ شهر</span></div>
              <p className="mt-1 text-xs text-muted-foreground">يشمل $10 Compute Credit؛ يغطي Micro Compute واحدًا تقريبًا في المشروع الأول.</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border bg-muted/20 p-4"><div className="text-xs text-muted-foreground">التكلفة الأساسية النقدية</div><div className="mt-1 text-xl font-black">{money(config.vercelPro + config.supabasePro)}</div><div className="text-xs text-muted-foreground">Vercel + Supabase</div></div>
            <div className="rounded-xl border bg-muted/20 p-4"><div className="text-xs text-muted-foreground">رصيد Supabase Compute</div><div className="mt-1 text-xl font-black">{money(config.supabaseComputeCredit)}</div><div className="text-xs text-muted-foreground">يُخصم من Compute فقط</div></div>
            <div className="rounded-xl border bg-muted/20 p-4"><div className="text-xs text-muted-foreground">الرصيد/الاستخدام في Vercel</div><div className="mt-1 text-xl font-black">{money(config.vercelUsageCredit)}</div><div className="text-xs text-muted-foreground">لا نطرحه من الاشتراك الثابت</div></div>
          </div>

          <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-4 text-sm dark:border-blue-900 dark:bg-blue-950/30">
            <div className="flex items-center gap-2 font-bold"><ShieldCheck className="h-4 w-4" /> النتيجة المحاسبية الصحيحة</div>
            <p className="mt-1 text-muted-foreground">للمشروع الأساسي: Vercel Pro = {money(config.vercelPro)} + Supabase Pro = {money(config.supabasePro)}، أي <strong>{money(config.vercelPro + config.supabasePro)} شهريًا</strong>. رصيد Supabase البالغ {money(config.supabaseComputeCredit)} لا يُطرح من الاشتراك؛ هو رصيد مقابل Compute. التخزين ونقل البيانات لا يضيفان تكلفة ما دام الاستخدام داخل الحصص.</p>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader><CardTitle className="text-base font-bold">2. محرك التكلفة والربح — يتغير لحظيًا</CardTitle></CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div><Label>عدد العدادات</Label><Input type="number" min="0" value={meters} onChange={(e) => setMeters(e.target.value)} className="mt-1.5 h-11 text-base" /></div>
            <div><Label>سعر الخدمة لكل عداد / شهر ($)</Label><Input type="number" min="0" step="0.0001" value={config.pricePerMeter} onChange={(e) => update("pricePerMeter", e.target.value)} className="mt-1.5 h-11 text-base" /></div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="الإيراد الشهري" value={money(projectCost.monthlyRevenue)} icon={<Wallet className="h-4 w-4" />} tone="positive" />
            <MetricCard label="التكلفة الشهرية" value={money(projectCost.total)} icon={<Calculator className="h-4 w-4" />} />
            <MetricCard label="الربح الشهري" value={money(projectCost.monthlyProfit)} icon={<CircleDollarSign className="h-4 w-4" />} tone={profitPositive ? "positive" : "negative"} />
            <MetricCard label="الربح السنوي" value={money(projectCost.annualProfit)} icon={<TrendingUp className="h-4 w-4" />} tone={profitPositive ? "positive" : "negative"} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border p-4"><div className="text-xs text-muted-foreground">الاستضافة والبنية</div><div className="mt-1 text-xl font-bold">{money(projectCost.hosting)}</div><div className="text-xs text-muted-foreground">Vercel + Supabase</div></div>
            <div className="rounded-xl border p-4"><div className="text-xs text-muted-foreground">معالجة AI</div><div className="mt-1 text-xl font-bold">{money(projectCost.ai)}</div><div className="text-xs text-muted-foreground">$0 حاليًا: المعالجة محلية</div></div>
            <div className="rounded-xl border p-4"><div className="text-xs text-muted-foreground">التخزين الزائد</div><div className="mt-1 text-xl font-bold">{money(projectCost.storage)}</div><div className="text-xs text-muted-foreground">$0 داخل الحصة</div></div>
            <div className="rounded-xl border p-4"><div className="text-xs text-muted-foreground">تكلفة العداد الحالية</div><div className="mt-1 text-xl font-bold">{moneyPrecise(projectCost.perMeterCost)}</div><div className="text-xs text-muted-foreground">تتناقص مع التوسع</div></div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-xl border bg-muted/20 p-4"><div className="text-sm text-muted-foreground">سعر الاستدامة / عداد</div><div className="mt-1 text-2xl font-black">{moneyPrecise(projectCost.suggestedPricePerMeter)}</div><div className="mt-1 text-xs text-muted-foreground">لتحقيق هامش {config.margin}%</div></div>
            <div className="rounded-xl border bg-muted/20 p-4"><div className="text-sm text-muted-foreground">سعر الاستدامة للمشروع</div><div className="mt-1 text-2xl font-black">{money(projectCost.suggestedProjectPrice)}</div><div className="mt-1 text-xs text-muted-foreground">{number(meterCount)} عداد / شهر</div></div>
            <div className={`rounded-xl border p-4 ${profitPositive ? "border-emerald-200 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/30" : "border-red-200 bg-red-50/70 dark:border-red-900 dark:bg-red-950/30"}`}><div className="text-sm text-muted-foreground">حالة النموذج</div><div className={`mt-1 text-2xl font-black ${profitPositive ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>{profitPositive ? "نموذج مربح" : "يحتاج رفع السعر"}</div></div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader><CardTitle className="text-base font-bold">3. محاكي التوسع</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div><Label>عدد المشاريع</Label><Input type="number" min="0" value={projects} onChange={(e) => setProjects(e.target.value)} className="mt-1.5" /></div>
              <div><Label>عدادات لكل مشروع</Label><Input type="number" min="0" value={metersPerProject} onChange={(e) => setMetersPerProject(e.target.value)} className="mt-1.5" /></div>
            </div>
            <div className="rounded-2xl border bg-muted/20 p-5">
              <div className="flex items-center gap-2 text-sm text-muted-foreground"><Gauge className="h-4 w-4" /> إجمالي العدادات</div>
              <div className="mt-1 text-3xl font-black">{number(scenarioMeters)}</div>
              <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
                <div><div className="text-muted-foreground">الإيراد</div><div className="font-bold text-emerald-700 dark:text-emerald-400">{money(scenario.revenue)}</div></div>
                <div><div className="text-muted-foreground">التكلفة</div><div className="font-bold">{money(scenario.cost)}</div></div>
                <div><div className="text-muted-foreground">الربح</div><div className={`font-bold ${scenario.profit >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>{money(scenario.profit)}</div></div>
              </div>
              <div className="mt-4 rounded-lg bg-background/70 p-3 text-sm">الربح السنوي المتوقع: <span className="font-black">{money(scenario.annualProfit)}</span> <span className="text-muted-foreground">(هامش {scenario.margin.toFixed(1)}%)</span></div>
              <p className="mt-3 text-xs text-muted-foreground">Vercel مشتركة على مستوى المنصة، بينما كل مشروع Supabase إضافي يضيف تكلفة Compute/مشروع. لذلك عدد المشاريع يؤثر في التكلفة.</p>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader><CardTitle className="text-base font-bold">4. أثر عدد العدادات على الربح</CardTitle></CardHeader>
          <CardContent className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={scaleData} margin={{ top: 10, right: 10, left: 0, bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="meters" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                <Tooltip formatter={(v: number) => money(v)} labelFormatter={(v) => `${number(Number(v))} عداد`} />
                <Bar dataKey="cost" name="التكلفة / شهر" fill="var(--muted-foreground)" radius={[5, 5, 0, 0]} />
                <Bar dataKey="profit" name="الربح / شهر" fill="var(--water)" radius={[5, 5, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base font-bold"><Zap className="h-4 w-4" /> 5. الأسعار الرسمية المرجعية</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-sm">
              <thead><tr className="border-b text-right"><th className="p-3">الخدمة بالعربي</th><th className="p-3">English</th><th className="p-3">السعر الرسمي</th><th className="p-3">المشمول</th></tr></thead>
              <tbody>
                <tr className="border-b"><td className="p-3 font-medium">استضافة التطبيق</td><td className="p-3">Vercel Pro</td><td className="p-3 font-bold">$20 / شهر</td><td className="p-3 text-muted-foreground">اشتراك Pro + استخدام حسب الخطة</td></tr>
                <tr className="border-b"><td className="p-3 font-medium">الخلفية وقاعدة البيانات</td><td className="p-3">Supabase Pro</td><td className="p-3 font-bold">$25 / شهر</td><td className="p-3 text-muted-foreground">100K MAU + 8 GB disk + 250 GB egress + 100 GB file storage + $10 Compute Credit</td></tr>
                <tr className="border-b"><td className="p-3 font-medium">تخزين الملفات الزائد</td><td className="p-3">Storage Over-Usage</td><td className="p-3 font-bold">$0.0213 / GB</td><td className="p-3 text-muted-foreground">بعد 100 GB</td></tr>
                <tr className="border-b"><td className="p-3 font-medium">نقل البيانات غير المخزن مؤقتًا الزائد</td><td className="p-3">Uncached Egress Over-Usage</td><td className="p-3 font-bold">$0.09 / GB</td><td className="p-3 text-muted-foreground">بعد 250 GB</td></tr>
                <tr><td className="p-3 font-medium">نقل البيانات المخزن مؤقتًا الزائد</td><td className="p-3">Cached Egress Over-Usage</td><td className="p-3 font-bold">$0.03 / GB</td><td className="p-3 text-muted-foreground">بعد 250 GB</td></tr>
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">المصدر المرجعي: أسعار Supabase الرسمية الحالية. Compute في Pro يبدأ من Micro بحوالي $10 شهريًا، ويُغطى برصيد $10 للمشروع الأول؛ المشاريع الإضافية تُحاسب على Compute. citeturn0search0turn0search1turn0search10</p>
          <p className="mt-2 text-xs text-muted-foreground">أسعار Vercel قابلة للاستهلاك حسب الخطة؛ قيمة Pro الأساسية المستخدمة في النموذج هي $20/شهر. راجع فاتورة Vercel الفعلية عند التشغيل التجاري لتثبيت أي Usage إضافي.</p>
        </CardContent>
      </Card>

      {user?.role === "super_admin" && (
        <Card className="shadow-sm">
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-base font-bold"><Settings2 className="h-4 w-4" /> إعدادات النموذج</CardTitle>
              <Button variant="outline" size="sm" onClick={resetConfig}>إرجاع الافتراضي</Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div><Label>Vercel Pro ($/شهر)</Label><Input type="number" min="0" step="0.01" value={config.vercelPro} onChange={(e) => update("vercelPro", e.target.value)} className="mt-1" /></div>
              <div><Label>Supabase Pro ($/شهر)</Label><Input type="number" min="0" step="0.01" value={config.supabasePro} onChange={(e) => update("supabasePro", e.target.value)} className="mt-1" /></div>
              <div><Label>AI ($/5,000 عداد)</Label><Input type="number" min="0" step="0.01" value={config.aiPer5000} onChange={(e) => update("aiPer5000", e.target.value)} className="mt-1" /></div>
              <div><Label>تخزين زائد ($/5,000)</Label><Input type="number" min="0" step="0.01" value={config.storagePer5000} onChange={(e) => update("storagePer5000", e.target.value)} className="mt-1" /></div>
              <div><Label>هامش الربح المستهدف %</Label><Input type="number" min="0" max="99" step="1" value={config.margin} onChange={(e) => update("margin", e.target.value)} className="mt-1" /></div>
              <div><Label>سعر الخدمة / عداد / شهر ($)</Label><Input type="number" min="0" step="0.0001" value={config.pricePerMeter} onChange={(e) => update("pricePerMeter", e.target.value)} className="mt-1" /></div>
            </div>
            <div className="mt-4 rounded-xl border bg-muted/20 p-4 text-xs text-muted-foreground">ملاحظة: AI والتخزين الزائد يبدآن من $0 في النموذج لأن النظام الحالي لا يستخدم API AI خارجيًا ولا يفترض تجاوز حصص التخزين. عند وجود استهلاك فعلي، أدخله في الإعدادات ليُعاد حساب الربح مباشرة.</div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
