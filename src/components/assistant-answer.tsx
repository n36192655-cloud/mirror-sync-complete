import { useId } from "react";
import type { AssistantTable } from "@/lib/assistant.functions";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CheckCircle2, Info, Printer, Table2 } from "lucide-react";

const numberFormatter = new Intl.NumberFormat("ar-YE", {
  maximumFractionDigits: 2,
});

function fmtCell(value: string | number | null): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return numberFormatter.format(value);
  return value;
}

function statusClass(value: string): string {
  const v = value.trim().toLocaleLowerCase("ar");

  // Negative states must be checked first because phrases such as
  // "غير مسدد" and "غير نشط" contain the positive words as substrings.
  if (["rejected", "unpaid", "suspended", "غير مسدد", "غير معتمد", "غير نشط", "مرفوض", "موقوف"].some((x) => v.includes(x))) {
    return "border-red-200/80 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/35 dark:text-red-300";
  }
  if (["pending", "partial", "issued", "معلق", "جزئي", "صادر", "قيد"].some((x) => v.includes(x))) {
    return "border-amber-200/80 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/35 dark:text-amber-300";
  }
  if (["approved", "paid", "active", "مؤكد", "مسدد", "نشط", "معتمد"].some((x) => v.includes(x))) {
    return "border-emerald-200/80 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/35 dark:text-emerald-300";
  }
  return "";
}

function renderInline(line: string, key: number) {
  const parts = line.split(/(\*\*[^*]+\*\*)/g);
  return (
    <p key={key} className="text-[14px] leading-7 text-foreground sm:text-[15px]">
      {parts.map((part, index) =>
        part.startsWith("**") && part.endsWith("**") ? (
          <strong key={index} className="font-bold text-foreground">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </p>
  );
}

function renderAnswerLine(line: string, index: number) {
  const text = line.trim();
  if (/^[-•*]\s+/.test(text)) {
    return (
      <div key={index} className="flex items-start gap-2.5 text-[14px] leading-7 sm:text-[15px]">
        <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">{renderInline(text.replace(/^[-•*]\s+/, ""), index)}</div>
      </div>
    );
  }

  if (/^#{1,3}\s+/.test(text)) {
    return (
      <h3 key={index} className="mt-5 border-b border-border/70 pb-2 text-[15px] font-bold leading-6 text-foreground first:mt-0 sm:text-base">
        {text.replace(/^#{1,3}\s+/, "")}
      </h3>
    );
  }

  return renderInline(text, index);
}

export function AssistantAnswerView({
  answer,
  tables,
}: {
  answer: string;
  tables: AssistantTable[];
}) {
  const printId = useId().replace(/:/g, "");
  const lines = answer.split("\n").filter((line) => line.trim() !== "");

  function printReport() {
    const previousTitle = document.title;
    document.title = "ميزان الذكي — تقرير تحليلي";
    window.print();
    window.setTimeout(() => {
      document.title = previousTitle;
    }, 500);
  }

  return (
    <section
      id={`assistant-report-${printId}`}
      dir="rtl"
      className="assistant-print-root space-y-4 font-sans [font-family:'Noto_Sans_Arabic','IBM_Plex_Sans_Arabic','Tajawal',system-ui,sans-serif]"
      aria-label="نتيجة ميزان الذكي"
    >
      <style>{`
        .assistant-print-root { font-variant-numeric: tabular-nums; }
        .assistant-table { border-collapse: separate; border-spacing: 0; }
        .assistant-table th,
        .assistant-table td { border-bottom: 1px solid hsl(var(--border) / 0.65); }
        .assistant-table th + th,
        .assistant-table td + td { border-right: 1px solid hsl(var(--border) / 0.45); }
        .assistant-table tbody tr:last-child td { border-bottom: 0; }
        .assistant-table tbody tr:nth-child(even) { background: hsl(var(--muted) / 0.18); }
        .assistant-table tbody tr:hover { background: hsl(var(--primary) / 0.055); }
        .assistant-table caption { caption-side: top; }
        @media (prefers-reduced-motion: reduce) {
          .assistant-table tbody tr { transition: none !important; }
        }
        @media print {
          body * { visibility: hidden !important; }
          .assistant-print-root, .assistant-print-root * { visibility: visible !important; }
          .assistant-print-root {
            position: absolute;
            inset: 0;
            width: 100%;
            padding: 14mm;
            background: white !important;
            color: black !important;
            font-family: 'Noto Sans Arabic', 'IBM Plex Sans Arabic', 'Tajawal', Arial, sans-serif !important;
          }
          .assistant-no-print { display: none !important; }
          .assistant-table { width: 100% !important; border-collapse: collapse !important; }
          .assistant-table th, .assistant-table td {
            border: 1px solid #cbd5e1 !important;
            padding: 7px !important;
            color: black !important;
            background: white !important;
          }
          .assistant-table tbody tr:nth-child(even) td { background: #f8fafc !important; }
          tr { break-inside: avoid; }
          @page { size: A4; margin: 8mm; }
        }
      `}</style>

      <article className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[0_6px_24px_-18px_hsl(var(--foreground)/0.35)]">
        <header className="flex items-center gap-3 border-b border-border/70 bg-gradient-to-l from-primary/[0.07] via-card to-card px-4 py-3.5 sm:px-5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
            <Info className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[14px] font-bold text-foreground sm:text-[15px]">تحليل ميزان الذكي</h2>
            <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground sm:text-xs">إجابة مبنية على البيانات الموثقة المتاحة وقت الاستعلام</p>
          </div>
          <div className="mr-auto flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={printReport}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-border/80 bg-background/80 px-2.5 text-[11px] font-semibold text-foreground shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:px-3 sm:text-xs"
              title="طباعة أو حفظ التقرير كملف PDF"
              aria-label="طباعة أو حفظ التقرير كملف PDF"
            >
              <Printer className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">طباعة / PDF</span>
              <span className="sm:hidden">PDF</span>
            </button>
            <span className="hidden h-9 w-9 items-center justify-center rounded-xl text-emerald-600 dark:text-emerald-400 sm:inline-flex" title="البيانات موثقة من أدوات النظام" aria-label="البيانات موثقة من أدوات النظام">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            </span>
          </div>
        </header>

        <div className="space-y-1 px-4 py-4 sm:px-5 sm:py-5">
          {lines.length > 0 ? lines.map(renderAnswerLine) : (
            <p className="text-sm leading-7 text-muted-foreground">لا توجد تفاصيل نصية إضافية.</p>
          )}
        </div>
      </article>

      {tables.map((table, tableIndex) => {
        const hasRows = table.rows.length > 0;
        const columnCount = table.columns.length;
        return (
          <article key={tableIndex} className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[0_6px_24px_-18px_hsl(var(--foreground)/0.35)]">
            <header className="flex items-center justify-between gap-3 border-b border-border/70 bg-muted/35 px-4 py-3 sm:px-5">
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Table2 className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <h3 className="truncate text-[13px] font-bold text-foreground sm:text-sm">{table.title}</h3>
                  <p className="mt-0.5 text-[10px] text-muted-foreground sm:text-[11px]">
                    {hasRows ? `${numberFormatter.format(table.rows.length)} صف · ${numberFormatter.format(columnCount)} أعمدة` : "لا توجد نتائج"}
                  </p>
                </div>
              </div>
              <span className="shrink-0 rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] font-medium text-muted-foreground" aria-label={hasRows ? `عدد الصفوف ${table.rows.length}` : "لا توجد نتائج"}>
                {hasRows ? numberFormatter.format(table.rows.length) : "0"}
              </span>
            </header>

            {hasRows ? (
              <div className="overflow-x-auto overscroll-x-contain">
                <Table className="assistant-table min-w-full text-right" aria-label={table.title}>
                  <caption className="sr-only">{table.title} — {numberFormatter.format(table.rows.length)} صف</caption>
                  <TableHeader className="bg-muted/55">
                    <TableRow className="hover:bg-transparent">
                      {table.columns.map((column, columnIndex) => (
                        <TableHead
                          key={`${column}-${columnIndex}`}
                          scope="col"
                          className="whitespace-nowrap px-3 py-3 text-right text-[11px] font-bold leading-5 text-foreground sm:px-4 sm:text-xs"
                        >
                          {column}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {table.rows.map((row, rowIndex) => (
                      <TableRow key={rowIndex} className="transition-colors">
                        {table.columns.map((_, columnIndex) => {
                          const cell = row[columnIndex] ?? null;
                          const text = fmtCell(cell);
                          const status = typeof cell === "string" ? statusClass(cell) : "";
                          const isNumber = typeof cell === "number";
                          return (
                            <TableCell
                              key={columnIndex}
                              className={`max-w-[22rem] whitespace-nowrap px-3 py-2.5 text-[11px] leading-5 text-foreground sm:px-4 sm:text-xs ${isNumber ? "text-left font-medium [font-variant-numeric:tabular-nums]" : "text-right"}`}
                              title={text}
                            >
                              {status ? (
                                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-5 sm:text-[11px] ${status}`}>
                                  {text}
                                </span>
                              ) : (
                                text
                              )}
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="px-4 py-8 text-center sm:py-10">
                <p className="text-sm font-medium text-muted-foreground">لا توجد بيانات لعرضها</p>
                <p className="mt-1 text-[11px] text-muted-foreground/80">سيظهر الجدول هنا عند توفر نتائج مطابقة للاستعلام.</p>
              </div>
            )}
          </article>
        );
      })}

      <footer className="hidden print:block border-t border-slate-300 pt-4 text-[9px] leading-5 text-slate-500">
        ميزان الذكي — تقرير تحليلي تشغيلي. تم إعداد التقرير من البيانات المتاحة وقت الاستعلام. لا يُستنتج منه ما لم تثبته البيانات.
      </footer>
    </section>
  );
}
