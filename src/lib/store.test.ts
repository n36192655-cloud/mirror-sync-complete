import { describe, expect, test } from "bun:test";
import { normalizeBillStatus } from "./store";

describe("normalizeBillStatus", () => {
  test("maps the canonical statuses without changing meaning", () => {
    expect(normalizeBillStatus("unpaid")).toBe("unpaid");
    expect(normalizeBillStatus("partial")).toBe("partial");
    expect(normalizeBillStatus("paid")).toBe("paid");
  });

  test("keeps legacy partially_paid records visible as partial", () => {
    expect(normalizeBillStatus("partially_paid")).toBe("partial");
  });

  test("fails closed to unpaid for unknown values", () => {
    expect(normalizeBillStatus(undefined)).toBe("unpaid");
    expect(normalizeBillStatus("unexpected")).toBe("unpaid");
  });
});
