import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { BarChart3, Calculator, DollarSign, Gauge, Settings2, TrendingUp, Wallet, CircleDollarSign } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
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
  platformBase: number;
  aiPer5000: number;
  storagePer5000: number;
  margin: number;
  readingsPerMeter: number;
  pricePerMeter: number;
};

const DEFAULT_CONFIG: CostConfig = {
  platformBase: 25,
  aiPer5000: 12.62,
  storagePer5000: 0.43,
  margin: 30,
  readingsPerMeter: 1,
  pricePerMeter: 18.64 / 5000,
};

const STORAGE_KEY = "mizan-cost-config-v2";

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
        <div className={`text-2xl font-black mt-3 ${valueClass}`}>{value}</div>
        {hint && <div className="text-xs text-muted-foreground mt-1">{hint}</div>}
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
    const total = config.platformBase + ai + storage;
    const suggestedPrice = config.margin >= 100 ? total : total / Math.max(0.01, 1 - config.margin / 100);
    const monthlyRevenue = config.pricePerMeter * meterCount;
    const monthlyProfit = monthlyRevenue - total;
    const annualRevenue = monthlyRevenue * 12;
    const annualCost = total * 12;
    const annualProfit = monthlyProfit * 12;
    const effectiveMargin = monthlyRevenue > 0 ? (monthlyProfit / monthlyRevenue) * 100 : 0;
    return {
      ai,
      storage,
      total,
      suggestedPrice,
      monthlyRevenue,
      monthlyProfit,
      annualRevenue,
      annualCost,
      annualProfit,
      effectiveMargin,
      perMeterCost: meterCount ? total / meterCount : 0,
    };
  }, [config, meterCount]);

  const scaleData = useMemo(() => [300, 1000, 5000, 10000, 20000].map((count) => {
    const scale = count / 5000;
    const cost = config.platformBase + (config.aiPer5000 + config.storagePer5000) * scale;
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
    const cost = config.platformBase + (config.aiPer5000 + config.storagePer5000) * scale;
    const revenue = config.pricePerMeter * scenarioMeters;
    return { cost, revenue, profit: revenue - cost, annualProfit: (revenue - cost) * 12 };
  }, [config, scenarioMeters]);

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
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <div className="rounded-xl bg-primary/10 p-2.5"><Calculator className="w-6 h-6 text-primary" /></div>
              <div>
                <h1 className="text-2xl md:text-3xl font-black tracking-tight">تكلفة واستدامة MIZAN</h1>
                <p className="text-sm text-muted-foreground mt-1">محاكاة مباشرة للتكلفة والإيرادات والربح أمام الإدارة ولجنة التقييم.</p>
              </div>
            </div>
          </div>
          <Badge className="w-fit px-3 py-1.5" variant="secondary">تقدير تشغيلي مباشر</Badge>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <MetricCard label="الإيراد الشهري" value={money(projectCost.monthlyRevenue)} hint="سعر الخدمة × عدد العدادات" icon={<Wallet className="w-4 h-4" />} tone="positive" />
        <MetricCard label="التكلفة الشهرية" value={money(projectCost.total)} hint="بنية + AI + تخزين" icon={<DollarSign className="w-4 h-4" />} />
        <MetricCard label="الربح الشهري" value={money(projectCost.monthlyProfit)} hint={`هامش فعلي ${projectCost.effectiveMargin.toFixed(1)}%`} icon={<CircleDollarSign className="w-4 h-4" />} tone={profitPositive ? "positive" : "negative"} />
        <MetricCard label="الربح السنوي" value={money(projectCost.annualProfit)} hint="الربح الشهري × 12" icon={<TrendingUp className="w-4 h-4" />} tone={profitPositive ? "positive" : "negative"} />
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-base font-bold">حاسبة المشروع — تتغير لحظيًا</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <Label>عدد العدادات</Label>
              <Input type="number" min="0" value={meters} onChange={(e) => setMeters(e.target.value)} className="mt-1.5 h-11 text-base" />
            </div>
            <div>
              <Label>سعر الخدمة لكل عداد / شهر ($)</Label>
              <Input type="number" min="0" step="0.0001" value={config.pricePerMeter} onChange={(e) => update("pricePerMeter", e.target.value)} className="mt-1.5 h-11 text-base" />
            </div>
          </div>

          <div className="rounded-2xl border bg-muted/20 p-4 md:p-5">
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricCard label="الإيراد" value={money(projectCost.monthlyRevenue)} icon={<Wallet className="w-4 h-4" />} tone="positive" />
              <MetricCard label="التكلفة التقنية" value={money(projectCost.total)} icon={<Calculator className="w-4 h-4" />} />
              <MetricCard label="الربح / شهر" value={money(projectCost.monthlyProfit)} icon={<CircleDollarSign className="w-4 h-4" />} tone={profitPositive ? "positive" : "negative"} />
              <MetricCard label="الربح / سنة" value={money(projectCost.annualProfit)} icon={<TrendingUp className="w-4 h-4" />} tone={profitPositive ? "positive" : "negative"} />
            </div>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-xl border p-4 bg-card"><div className="text-xs text-muted-foreground">AI / شهر</div><div className="text-xl font-bold mt-1">{money(projectCost.ai)}</div></div>
            <div className="rounded-xl border p-4 bg-card"><div className="text-xs text-muted-foreground">التخزين / شهر</div><div className="text-xl font-bold mt-1">{money(projectCost.storage)}</div></div>
            <div className="rounded-xl border p-4 bg-card"><div className="text-xs text-muted-foreground">تكلفة العداد</div><div className="text-xl font-bold mt-1">{moneyPrecise(projectCost.perMeterCost)}</div></div>
            <div className="rounded-xl border p-4 bg-card"><div className="text-xs text-muted-foreground">الإيراد السنوي</div><div className="text-xl font-bold mt-1">{money(projectCost.annualRevenue)}</div></div>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            <div className="rounded-xl border p-4 bg-muted/20"><div className="text-sm text-muted-foreground">سعر الاستدامة المقترح</div><div className="text-xl font-black mt-1">{money(projectCost.suggestedPrice)}</div><div className="text-xs text-muted-foreground mt-1">للمشروع / شهر عند هامش {config.margin}%</div></div>
            <div className="rounded-xl border p-4 bg-muted/20"><div className="text-sm text-muted-foreground">إجمالي التكلفة السنوية</div><div className="text-xl font-black mt-1">{money(projectCost.annualCost)}</div></div>
            <div className={`rounded-xl border p-4 ${profitPositive ? "border-emerald-200 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/30" : "border-red-200 bg-red-50/70 dark:border-red-900 dark:bg-red-950/30"}`}>
              <div className="text-sm text-muted-foreground">النتيجة</div>
              <div className={`text-xl font-black mt-1 ${profitPositive ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>{profitPositive ? "نموذج مربح" : "يحتاج رفع سعر الخدمة"}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="shadow-sm">
          <CardHeader><CardTitle className="text-base font-bold">محاكي التوسع</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div><Label>عدد المشاريع</Label><Input type="number" min="0" value={projects} onChange={(e) => setProjects(e.target.value)} className="mt-1.5" /></div>
              <div><Label>عدادات لكل مشروع</Label><Input type="number" min="0" value={metersPerProject} onChange={(e) => setMetersPerProject(e.target.value)} className="mt-1.5" /></div>
            </div>
            <div className="rounded-2xl border bg-muted/20 p-5">
              <div className="text-sm text-muted-foreground">إجمالي العدادات</div>
              <div className="text-3xl font-black mt-1">{number(scenarioMeters)}</div>
              <div className="grid grid-cols-3 gap-3 mt-4 text-sm">
                <div><div className="text-muted-foreground">الإيراد</div><div className="font-bold text-emerald-700 dark:text-emerald-400">{money(scenario.revenue)}</div></div>
                <div><div className="text-muted-foreground">التكلفة</div><div className="font-bold">{money(scenario.cost)}</div></div>
                <div><div className="text-muted-foreground">الربح</div><div className={`font-bold ${scenario.profit >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>{money(scenario.profit)}</div></div>
              </div>
              <div className="mt-4 rounded-lg bg-background/70 p-3 text-sm">الربح السنوي المتوقع: <span className="font-black">{money(scenario.annualProfit)}</span></div>
            </div>
            <p className="text-xs text-muted-foreground">البنية الأساسية مشتركة، بينما AI والتخزين يتدرجان مع حجم الاستخدام.</p>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader><CardTitle className="text-base font-bold">التكلفة والربح مع التوسع</CardTitle></CardHeader>
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

      {user?.role === "super_admin" && (
        <Card className="shadow-sm">
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base font-bold flex items-center gap-2"><Settings2 className="w-4 h-4" /> إعدادات نموذج التكلفة</CardTitle>
              <Button variant="outline" size="sm" onClick={resetConfig}>إرجاع الافتراضي</Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid sm:grid-cols-2 lg:grid-cols-6 gap-4">
              <div><Label>البنية $/شهر</Label><Input type="number" step="0.01" value={config.platformBase} onChange={(e) => update("platformBase", e.target.value)} className="mt-1" /></div>
              <div><Label>AI / 5,000 $</Label><Input type="number" step="0.01" value={config.aiPer5000} onChange={(e) => update("aiPer5000", e.target.value)} className="mt-1" /></div>
              <div><Label>التخزين / 5,000 $</Label><Input type="number" step="0.01" value={config.storagePer5000} onChange={(e) => update("storagePer5000", e.target.value)} className="mt-1" /></div>
              <div><Label>هامش السعر %</Label><Input type="number" step="1" min="0" max="99" value={config.margin} onChange={(e) => update("margin", e.target.value)} className="mt-1" /></div>
              <div><Label>قراءات / عداد</Label><Input type="number" step="0.1" min="0" value={config.readingsPerMeter} onChange={(e) => update("readingsPerMeter", e.target.value)} className="mt-1" /></div>
              <div><Label>سعر العداد / شهر $</Label><Input type="number" step="0.0001" min="0" value={config.pricePerMeter} onChange={(e) => update("pricePerMeter", e.target.value)} className="mt-1" /></div>
            </div>
            <p className="text-xs text-muted-foreground mt-4">تتغير كل المؤشرات مباشرة عند تعديل عدد العدادات أو سعر الخدمة أو أي تكلفة.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
