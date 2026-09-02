import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { BarChart3, Calculator, DollarSign, Gauge, Settings2, TrendingUp } from "lucide-react";
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
};

const DEFAULT_CONFIG: CostConfig = {
  platformBase: 25,
  aiPer5000: 12.62,
  storagePer5000: 0.43,
  margin: 30,
  readingsPerMeter: 1,
};

const STORAGE_KEY = "mizan-cost-config-v1";

function money(value: number) {
  return `$${value.toFixed(2)}`;
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

function CostCard({ label, value, hint, icon }: { label: string; value: string; hint?: string; icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm text-muted-foreground">{label}</div>
          <div className="rounded-lg bg-muted p-2">{icon}</div>
        </div>
        <div className="text-2xl font-bold mt-3">{value}</div>
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
    const servicePrice = config.margin >= 100 ? total : total / Math.max(0.01, 1 - config.margin / 100);
    return { ai, storage, total, servicePrice, annual: servicePrice * 12, perMeter: meterCount ? total / meterCount : 0 };
  }, [config, meterCount]);

  const scaleData = useMemo(() => [
    300, 1000, 5000, 10000, 20000,
  ].map((count) => {
    const scale = count / 5000;
    return {
      meters: count,
      cost: Number((config.platformBase + config.aiPer5000 * scale + config.storagePer5000 * scale).toFixed(2)),
    };
  }), [config]);

  const scenarioMeters = projectCount * perProject;
  const scenario = useMemo(() => {
    const scale = scenarioMeters / 5000;
    return config.platformBase + (config.aiPer5000 + config.storagePer5000) * scale;
  }, [config, scenarioMeters]);

  function update<K extends keyof CostConfig>(key: K, value: string) {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    setConfig((current) => ({ ...current, [key]: n }));
  }

  function resetConfig() {
    setConfig(DEFAULT_CONFIG);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Calculator className="w-6 h-6 text-primary" />
            <h1 className="text-2xl md:text-3xl font-bold">تكلفة واستدامة MIZAN</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">حاسبة تشغيلية لعرض تكلفة المنصة واقتصاديات التوسع أمام الإدارة ولجنة التقييم.</p>
        </div>
        <Badge variant="secondary">تقدير تشغيلي قابل للضبط</Badge>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <CostCard label="البنية الأساسية المشتركة" value={money(config.platformBase)} hint="تكلفة شهرية أساسية للمنصة" icon={<DollarSign className="w-4 h-4" />} />
        <CostCard label="عدد العدادات المختار" value={number(meterCount)} hint="مدخل المحاكاة الحالية" icon={<Gauge className="w-4 h-4" />} />
        <CostCard label="التكلفة لكل عداد" value={money(projectCost.perMeter)} hint="تقديرية حسب المدخلات الحالية" icon={<BarChart3 className="w-4 h-4" />} />
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">حاسبة تكلفة المشروع</CardTitle></CardHeader>
        <CardContent className="space-y-5">
          <div className="max-w-sm">
            <Label>عدد العدادات</Label>
            <Input type="number" min="0" value={meters} onChange={(e) => setMeters(e.target.value)} className="mt-1" />
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <CostCard label="AI" value={money(projectCost.ai)} icon={<TrendingUp className="w-4 h-4" />} />
            <CostCard label="التخزين" value={money(projectCost.storage)} icon={<BarChart3 className="w-4 h-4" />} />
            <CostCard label="البنية المشتركة" value={money(config.platformBase)} icon={<DollarSign className="w-4 h-4" />} />
            <CostCard label="التكلفة التقنية" value={money(projectCost.total)} icon={<Calculator className="w-4 h-4" />} />
            <CostCard label="سعر الاستدامة" value={money(projectCost.servicePrice)} hint={`هامش سعر بيع ${config.margin}%`} icon={<TrendingUp className="w-4 h-4" />} />
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="rounded-xl border p-4 bg-muted/20">
              <div className="text-sm text-muted-foreground">القيمة السنوية المقترحة</div>
              <div className="text-2xl font-bold mt-1">{money(projectCost.annual)}</div>
            </div>
            <div className="rounded-xl border p-4 bg-muted/20">
              <div className="text-sm text-muted-foreground">القراءات الشهرية المقدرة</div>
              <div className="text-2xl font-bold mt-1">{number(meterCount * config.readingsPerMeter)}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-base">محاكي التوسع</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div><Label>عدد المشاريع</Label><Input type="number" min="0" value={projects} onChange={(e) => setProjects(e.target.value)} className="mt-1" /></div>
              <div><Label>عدادات لكل مشروع</Label><Input type="number" min="0" value={metersPerProject} onChange={(e) => setMetersPerProject(e.target.value)} className="mt-1" /></div>
            </div>
            <div className="rounded-xl border p-4">
              <div className="text-sm text-muted-foreground">إجمالي العدادات</div>
              <div className="text-2xl font-bold">{number(scenarioMeters)}</div>
              <div className="text-sm text-muted-foreground mt-2">التكلفة التقنية المقدرة: <span className="font-semibold text-foreground">{money(scenario)} / شهر</span></div>
            </div>
            <p className="text-xs text-muted-foreground">التكلفة الأساسية مشتركة؛ المتغيرات تتدرج مع الاستخدام بدل تكرار اشتراك منصة كامل لكل مشروع.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">منحنى التكلفة مع التوسع</CardTitle></CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={scaleData} margin={{ top: 10, right: 10, left: 0, bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="meters" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                <Tooltip formatter={(v: number) => money(v)} labelFormatter={(v) => `${number(Number(v))} عداد`} />
                <Bar dataKey="cost" name="التكلفة التقنية / شهر" fill="var(--water)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {user?.role === "super_admin" && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base flex items-center gap-2"><Settings2 className="w-4 h-4" /> إعدادات التكلفة</CardTitle>
              <Button variant="outline" size="sm" onClick={resetConfig}>إرجاع الافتراضي</Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4">
              <div><Label>البنية الأساسية $/شهر</Label><Input type="number" step="0.01" value={config.platformBase} onChange={(e) => update("platformBase", e.target.value)} className="mt-1" /></div>
              <div><Label>AI لكل 5,000 عداد $</Label><Input type="number" step="0.01" value={config.aiPer5000} onChange={(e) => update("aiPer5000", e.target.value)} className="mt-1" /></div>
              <div><Label>التخزين لكل 5,000 $</Label><Input type="number" step="0.01" value={config.storagePer5000} onChange={(e) => update("storagePer5000", e.target.value)} className="mt-1" /></div>
              <div><Label>هامش سعر البيع %</Label><Input type="number" step="1" min="0" max="99" value={config.margin} onChange={(e) => update("margin", e.target.value)} className="mt-1" /></div>
              <div><Label>قراءات/عداد/شهر</Label><Input type="number" step="0.1" min="0" value={config.readingsPerMeter} onChange={(e) => update("readingsPerMeter", e.target.value)} className="mt-1" /></div>
            </div>
            <p className="text-xs text-muted-foreground mt-4">الإعدادات تحفظ محليًا على جهاز العرض الحالي. لا تُعرض للمستخدمين ذوي الصلاحيات الأخرى.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
