import { describe, expect, test } from "bun:test";
import {
  billBalance,
  computeFinancials,
  normalizeBillStatus,
  type Bill,
  type Payment,
} from "./store";

const payments: Payment[] = [];

function bill(id: number, status: Bill["status"], total: number, paid = 0): Bill {
  return {
    id,
    serial: `INV-${id}`,
    customer_id: 1,
    meter_id: 1,
    reading_id: id,
    subtotal: total,
    arrears: 0,
    total,
    paid,
    status,
    date: "2026-09-07",
  };
}

describe("financial KPI treatment of void bills", () => {
  test("normal unpaid bill contributes to billed, outstanding and unpaid count", () => {
    const result = computeFinancials([bill(1, "unpaid", 100)], payments);
    expect(result).toEqual({
      totalBilled: 100,
      totalCollected: 0,
      outstanding: 100,
      collectionRate: 0,
      paidBills: 0,
      unpaidBills: 1,
    });
  });

  test("paid bill has no outstanding balance", () => {
    const result = computeFinancials([bill(1, "paid", 100, 100)], payments);
    expect(result.outstanding).toBe(0);
    expect(result.paidBills).toBe(1);
    expect(result.unpaidBills).toBe(0);
    expect(result.collectionRate).toBe(100);
  });

  test("partial bill contributes only its remaining balance", () => {
    const result = computeFinancials([bill(1, "partial", 100, 40)], payments);
    expect(result.totalBilled).toBe(100);
    expect(result.totalCollected).toBe(40);
    expect(result.outstanding).toBe(60);
    expect(result.unpaidBills).toBe(1);
    expect(result.collectionRate).toBe(40);
  });

  test("void bill contributes to no collection KPI and has zero balance", () => {
    const voidBill = bill(1, "void", 100, 0);
    const result = computeFinancials([voidBill], payments);
    expect(normalizeBillStatus("void")).toBe("void");
    expect(billBalance(voidBill, payments)).toBe(0);
    expect(result).toEqual({
      totalBilled: 0,
      totalCollected: 0,
      outstanding: 0,
      collectionRate: 0,
      paidBills: 0,
      unpaidBills: 0,
    });
  });

  test("mixed bills exclude void while preserving paid, partial and unpaid semantics", () => {
    const result = computeFinancials([
      bill(1, "paid", 100, 100),
      bill(2, "partial", 100, 25),
      bill(3, "unpaid", 50),
      bill(4, "void", 999),
    ], payments);
    expect(result.totalBilled).toBe(250);
    expect(result.totalCollected).toBe(125);
    expect(result.outstanding).toBe(125);
    expect(result.paidBills).toBe(1);
    expect(result.unpaidBills).toBe(2);
    expect(result.collectionRate).toBe(50);
  });
});
