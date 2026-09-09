import { describe, expect, test } from "bun:test";
import { createEvidenceRecord, validateFinalOutput } from "./evidence";

describe("assistant evidence validation", () => {
  test("accepts claims whose values exist in authoritative tool evidence", () => {
    const evidence = [createEvidenceRecord("get_customer_period_summary", { billed_amount: 12500, balance: 3200 })];
    const result = validateFinalOutput(
      '<FINAL_JSON>{"answer":"إجمالي المفوتر 12,500 ريال","claims":[{"text":"إجمالي المفوتر 12,500 ريال","source_tool":"get_customer_period_summary","value":12500}],"suggestions":[]}</FINAL_JSON>',
      evidence,
    );
    expect(result?.answer).toContain("12,500");
  });

  test("rejects fabricated values", () => {
    const evidence = [createEvidenceRecord("get_customer_period_summary", { billed_amount: 12500 })];
    const result = validateFinalOutput(
      '<FINAL_JSON>{"answer":"إجمالي المفوتر 99,999 ريال","claims":[{"text":"إجمالي المفوتر 99,999 ريال","source_tool":"get_customer_period_summary","value":99999}],"suggestions":[]}</FINAL_JSON>',
      evidence,
    );
    expect(result).toBeNull();
  });

  test("rejects a claim from an unavailable or unauthorized tool", () => {
    const evidence = [createEvidenceRecord("list_bills", { total: 4 })];
    const result = validateFinalOutput(
      '<FINAL_JSON>{"answer":"عدد الفواتير 4","claims":[{"text":"عدد الفواتير 4","source_tool":"get_all_customers","value":4}],"suggestions":[]}</FINAL_JSON>',
      evidence,
    );
    expect(result).toBeNull();
  });

  test("fails closed when evidence is too large and marked incomplete", () => {
    const huge = { payload: "x".repeat(50_000) };
    const evidence = [createEvidenceRecord("list_customers", huge)];
    const result = validateFinalOutput(
      '<FINAL_JSON>{"answer":"وجدت بيانات","claims":[{"text":"بيانات","source_tool":"list_customers","value":"x"}],"suggestions":[]}</FINAL_JSON>',
      evidence,
    );
    expect(result).toBeNull();
  });
});
