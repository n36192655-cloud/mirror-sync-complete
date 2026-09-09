import { describe, expect, test } from "bun:test";
import { createEvidenceRecord, validateFinalOutput } from "./evidence";

describe("assistant evidence validation", () => {
  test("accepts a claim only when field_path and evidence_id match", () => {
    const evidence = [createEvidenceRecord("get_customer_period_summary", { totals: { billed_amount: 12500, balance: 3200 } })];
    const id = evidence[0].id;
    const result = validateFinalOutput(
      `<FINAL_JSON>{"answer":"إجمالي المفوتر 12,500 ريال","claims":[{"text":"إجمالي المفوتر 12,500 ريال","source_tool":"get_customer_period_summary","evidence_id":"${id}","field_path":"totals.billed_amount","value":12500}],"suggestions":[]}</FINAL_JSON>`,
      evidence,
    );
    expect(result?.claims).toHaveLength(1);
  });

  test("accepts grounded dates and structured identifiers as string claims", () => {
    const evidence = [
      createEvidenceRecord("get_customer_overview", {
        customer: { pay_account: "120045", meter_serial: "M-2026-09" },
        last_bill: { issued_at: "2026-09-08" },
      }),
    ];
    const id = evidence[0].id;
    const result = validateFinalOutput(
      `<FINAL_JSON>{"answer":"الحساب 120045، العداد M-2026-09، وآخر فاتورة بتاريخ 2026-09-08","claims":[{"text":"الحساب 120045","source_tool":"get_customer_overview","evidence_id":"${id}","field_path":"customer.pay_account","value":"120045"},{"text":"العداد M-2026-09","source_tool":"get_customer_overview","evidence_id":"${id}","field_path":"customer.meter_serial","value":"M-2026-09"},{"text":"آخر فاتورة بتاريخ 2026-09-08","source_tool":"get_customer_overview","evidence_id":"${id}","field_path":"last_bill.issued_at","value":"2026-09-08"}],"suggestions":[]}</FINAL_JSON>`,
      evidence,
    );
    expect(result?.claims).toHaveLength(3);
  });

  test("rejects fabricated values", () => {
    const evidence = [createEvidenceRecord("get_customer_period_summary", { totals: { billed_amount: 12500 } })];
    const id = evidence[0].id;
    const result = validateFinalOutput(
      `<FINAL_JSON>{"answer":"إجمالي المفوتر 99,999 ريال","claims":[{"text":"إجمالي المفوتر 99,999 ريال","source_tool":"get_customer_period_summary","evidence_id":"${id}","field_path":"totals.billed_amount","value":99999}],"suggestions":[]}</FINAL_JSON>`,
      evidence,
    );
    expect(result).toBeNull();
  });

  test("rejects a claim from an unavailable or unauthorized tool", () => {
    const evidence = [createEvidenceRecord("list_bills", { total: 4 })];
    const result = validateFinalOutput(
      '<FINAL_JSON>{"answer":"عدد الفواتير 4","claims":[{"text":"عدد الفواتير 4","source_tool":"get_all_customers","evidence_id":"not-real","field_path":"total","value":4}],"suggestions":[]}</FINAL_JSON>',
      evidence,
    );
    expect(result).toBeNull();
  });

  test("rejects a correct value pointing at the wrong field", () => {
    const evidence = [createEvidenceRecord("get_customer_period_summary", { totals: { billed: 12500, paid: 9000 } })];
    const id = evidence[0].id;
    const result = validateFinalOutput(
      `<FINAL_JSON>{"answer":"إجمالي المدفوع 12,500 ريال","claims":[{"text":"إجمالي المدفوع 12,500 ريال","source_tool":"get_customer_period_summary","evidence_id":"${id}","field_path":"totals.paid","value":12500}],"suggestions":[]}</FINAL_JSON>`,
      evidence,
    );
    expect(result).toBeNull();
  });

  test("rejects unsupported numeric prose even if another claim is grounded", () => {
    const evidence = [createEvidenceRecord("get_customer_period_summary", { totals: { billed: 12500, invoice_count: 99 } })];
    const id = evidence[0].id;
    const result = validateFinalOutput(
      `<FINAL_JSON>{"answer":"إجمالي المفوتر 12,500 ريال وعدد الفواتير 99","claims":[{"text":"إجمالي المفوتر 12,500 ريال","source_tool":"get_customer_period_summary","evidence_id":"${id}","field_path":"totals.billed","value":12500}],"suggestions":[]}</FINAL_JSON>`,
      evidence,
    );
    expect(result).toBeNull();
  });

  test("rejects a numeric value that exists in evidence but is not claimed", () => {
    const evidence = [createEvidenceRecord("get_customer_period_summary", { totals: { billed: 12500, paid: 9000 } })];
    const id = evidence[0].id;
    const result = validateFinalOutput(
      `<FINAL_JSON>{"answer":"إجمالي المفوتر 12,500 ريال والمدفوع 9,000 ريال","claims":[{"text":"إجمالي المفوتر 12,500 ريال","source_tool":"get_customer_period_summary","evidence_id":"${id}","field_path":"totals.billed","value":12500}],"suggestions":[]}</FINAL_JSON>`,
      evidence,
    );
    expect(result).toBeNull();
  });

  test("accepts Arabic-Indic digits when the grounded scalar matches", () => {
    const evidence = [createEvidenceRecord("get_customer_period_summary", { totals: { billed: 12500 } })];
    const id = evidence[0].id;
    const result = validateFinalOutput(
      `<FINAL_JSON>{"answer":"إجمالي المفوتر ١٢٬٥٠٠ ريال","claims":[{"text":"إجمالي المفوتر ١٢٬٥٠٠ ريال","source_tool":"get_customer_period_summary","evidence_id":"${id}","field_path":"totals.billed","value":12500}],"suggestions":[]}</FINAL_JSON>`,
      evidence,
    );
    expect(result?.claims).toHaveLength(1);
  });

  test("rejects numeric substrings that are not actually present as evidence values", () => {
    const evidence = [createEvidenceRecord("get_customer_period_summary", { totals: { billed: 1000 } })];
    const id = evidence[0].id;
    const result = validateFinalOutput(
      `<FINAL_JSON>{"answer":"المبلغ 100 ريال","claims":[{"text":"المبلغ 100 ريال","source_tool":"get_customer_period_summary","evidence_id":"${id}","field_path":"totals.billed","value":100}],"suggestions":[]}</FINAL_JSON>`,
      evidence,
    );
    expect(result).toBeNull();
  });

  test("fails closed when evidence is too large and marked incomplete", () => {
    const huge = { payload: "x".repeat(70_000) };
    const evidence = [createEvidenceRecord("list_customers", huge)];
    const result = validateFinalOutput(
      `<FINAL_JSON>{"answer":"وجدت بيانات","claims":[{"text":"بيانات","source_tool":"list_customers","evidence_id":"${evidence[0].id}","field_path":"payload","value":"x"}],"suggestions":[]}</FINAL_JSON>`,
      evidence,
    );
    expect(result).toBeNull();
  });
});
