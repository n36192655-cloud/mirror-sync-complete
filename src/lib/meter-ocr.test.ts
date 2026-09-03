import { describe, expect, test } from "bun:test";
import { isTechnicalNumberToken, normalizeDigits, normalizeSerial, serialFoundInOcrText } from "./meter-ocr";

describe("meter OCR safeguards", () => {
  test("canonicalizes Arabic, Persian and common Indic digits", () => {
    expect(normalizeDigits("١٢٣٤٥٦٧٨٩٠")).toBe("1234567890");
    expect(normalizeDigits("۱۲۳۴۵۶۷۸۹۰")).toBe("1234567890");
    expect(normalizeDigits("१२३४५६७८९०")).toBe("1234567890");
    expect(normalizeDigits("১২৩৪৫৬৭৮৯০")).toBe("1234567890");
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

  test("recognizes an exact serial when OCR split it across a line", () => {
    expect(serialFoundInOcrText("Water Meter\nAB 12-٣٤\nReading 001234", "AB-12-34")).toBe(true);
    expect(serialFoundInOcrText("Water Meter\nAB 12-٣٥\nReading 001234", "AB-12-34")).toBe(false);
  });

  test("rejects technical markings that can look like readings", () => {
    expect(isTechnicalNumberToken("R160")).toBe(true);
    expect(isTechnicalNumberToken("DN50")).toBe(true);
    expect(isTechnicalNumberToken("DN150")).toBe(true);
    expect(isTechnicalNumberToken("Q3 2.5")).toBe(true);
    expect(isTechnicalNumberToken("2025")).toBe(true);
    expect(isTechnicalNumberToken("12345")).toBe(false);
  });
});
