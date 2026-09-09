import { useId } from "react";
import type { AssistantTable } from "@/lib/assistant.functions";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FileDown, Printer } from "lucide-react";

function fmtCell(v: string | number | null): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") return new Intl.NumberFormat("ar-YE", { maximumFractionDigits: 2 }).format(v);
  return v;
}

function statusClass(value: string): string {
  const v = value.toLowerCase();
  if (["approved", "paid", "active", "مؤكد", "مسدد", "نشط"].some((x) => v.includes(x))) return "text-emerald-700 bg-emerald-50 border-emerald-200";
  if (["pending", "partial", "issued", "معلق", "جزئي", "صادر"].some((x) => v.includes(x))) return "text-amber-700 bg-amber-50 border-amber-200";
  if (["rejected", "unpaid", "suspended", "مرفوض", "غير مسدد", "موقوف"].some((x) => v.includes(x))) return "text-red-700 bg-red-50 border-red-200";
  return "";
}

function renderInline(line: string, key: number) {
  const parts = line.split(/(\*\*[^*]+\*\*)/g);
  return (
    <p key={key} className="text-sm leading-7 text-foreground">
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i} className="font-semibold">{p.slice(2, -2)}</strong>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </p>
  );
}

export function AssistantAnswerView({
  answer,
  tables,
}: {
  answer: string;
  tables: AssistantTable[];
}) {
  const printId = useId().replace(/:/g, "");
  const lines = answer.split("\n").filter((l) => l.trim() !== "");

  function printReport() {
    const previousTitle = document.title;
    document.title = "ميزان الذكي — تقرير تحليلي";
    window.print();
    window.setTimeout(() => { document.title = previousTitle; }, 500);
  }

  return (
    <section id={`assistant-report-${printId}`} className="assistant-print-root space-y-3" aria-label="نتيجة ميزان الذكي">
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          .assistant-print-root, .assistant-print-root * { visibility: visible !important; }
          .assistant-print-root { position: absolute; inset: 0; width: 100%; padding: 18mm; background: white !important; color: black !important; }
          .assistant-no-print { display: none !important; }
          table { width: 100% !important; border-collapse: collapse !important; }
          th, td { border: 1px solid #cbd5e1 !important; padding: 7px !important; }
          tr { break-inside: avoid; }
          @page { size: A4; margin: 10mm; }
        }
      `}</style>

      <div className="rounded-2xl border bg-card px-4 py-3 shadow-sm space-y-2">
        <div className="flex items-center gap-2 border-b pb-2 assistant-no-print">
          <div className="text-xs font-semibold text-primary">تحليل ميزان الذكي</div>
          <div className="mr-auto flex items-center gap-1.5">
            <button type="button" onClick={printReport} className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium hover:bg-muted transition-colors" title="طباعة أو حفظ التقرير كملف PDF">
              <Printer className="h-3.5 w-3.5" /> طباعة / PDF
            </button>
            <FileDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          </div>
        </div>
        <div className="text-sm text-muted-foreground print:hidden">تقرير قابل للطباعة والحفظ بصيغة PDF — مبني على البيانات الحالية الموثقة.</div>
        <div className="space-y-1">
          {lines.map((line, i) => {
            const t = line.trim();
            if (/^[-•*]\s+/.test(t)) {
              return (
                <div key={i} className="flex gap-2 text-sm leading-7">
                  <span className="text-primary font-bold" aria-hidden="true">•</span>
                  <span className="flex-1">{renderInline(t.replace(/^[-•*]\s+/, ""), i)}</span>
                </div>
              );
            }
            if (/^#{1,3}\s+/.test(t)) {
              return (
                <h3 key={i} className="text-base font-bold mt-3 text-foreground border-b pb-1">
                  {t.replace(/^#{1,3}\s+/, "")}
                </h3>
              );
            }
            return renderInline(t, i);
          })}
        </div>
      </div>

      {tables.map((tb, ti) => (
        <div key={ti} className="rounded-2xl border overflow-hidden shadow-sm bg-card">
          <div className="px-4 py-2.5 bg-muted/50 text-xs font-semibold border-b">{tb.title}</div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {tb.columns.map((c) => (
                    <TableHead key={c} className="text-xs whitespace-nowrap font-semibold">{c}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {tb.rows.map((row, ri) => (
                  <TableRow key={ri}>
                    {row.map((cell, ci) => {
                      const text = fmtCell(cell);
                      const status = typeof cell === "string" ? statusClass(cell) : "";
                      return (
                        <TableCell key={ci} className="text-xs whitespace-nowrap align-middle">
                          {status ? (
                            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${status}`}>
                              {text}
                            </span>
                          ) : text}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ))}

      <div className="hidden print:block text-[10px] text-slate-500 pt-4 border-t mt-5">
        ميزان الذكي — تقرير تحليلي تشغيلي. تم إعداد التقرير من البيانات المتاحة وقت الاستعلام. لا يُستنتج منه ما لم تثبته البيانات.
      </div>
    </section>
  );
}
