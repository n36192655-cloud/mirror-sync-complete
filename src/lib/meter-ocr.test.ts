import { describe, expect, test } from "bun:test";
import { normalizeDigits, normalizeSerial } from "./meter-ocr";

describe("meter OCR identity normalization", () => {
  test("canonicalizes Arabic and Persian digits", () => {
    expect(normalizeDigits("١٢٣٤٥٦٧٨٩٠")).toBe("1234567890");
    expect(normalizeDigits("۱۲۳۴۵۶۷۸۹۰")).toBe("1234567890");
  });

  test("keeps serial matching exact after safe formatting normalization", () => {
    expect(normalizeSerial("ab 12-٣٤")).toBe("AB-12-34");
    expect(normalizeSerial("AB_12—34")).toBe("AB-12-34");
    expect(normalizeSerial("AB-12-35")).not.toBe(normalizeSerial("AB-12-34"));
  });

  test("does not turn partial serials into a match", () => {
    expect(normalizeSerial("12345")).not.toBe(normalizeSerial("123456"));
    expect(normalizeSerial("ABC123")).not.toBe(normalizeSerial("ABC1234"));
  });
});
