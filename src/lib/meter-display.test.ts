import { describe, expect, test } from "bun:test";
import {
  isDisplayTypeRequiringStrongEvidence,
  normalizeMeterDigits,
  normalizeMeterDisplayType,
  parseMeterReading,
} from "./meter-display";

describe("meter display primitives", () => {
  test("normalizes Arabic and Persian digits", () => {
    expect(normalizeMeterDigits("١٢٣٤۵٦")).toBe("123456");
  });

  test("accepts all supported display classifications and rejects unknown values", () => {
    expect(normalizeMeterDisplayType("digital-lcd")).toBe("digital_lcd");
    expect(normalizeMeterDisplayType("BLACK RED REGISTER")).toBe("black_red_register");
    expect(normalizeMeterDisplayType("not-a-meter-type")).toBe("unknown");
  });

  test("parses decimal readings without changing digit meaning", () => {
    expect(parseMeterReading("١٢٣,٤٥")).toEqual({ value: 123.45, normalized: "123.45", valid: true });
    expect(parseMeterReading("123456789012").value).toBe(123456789012);
  });

  test("rejects malformed or over-precise readings", () => {
    expect(parseMeterReading("12.3456").valid).toBe(false);
    expect(parseMeterReading("serial-123").valid).toBe(false);
    expect(parseMeterReading("").valid).toBe(false);
  });

  test("marks high-risk display types for stronger evidence", () => {
    expect(isDisplayTypeRequiringStrongEvidence("analog_dial")).toBe(true);
    expect(isDisplayTypeRequiringStrongEvidence("multi_register")).toBe(true);
    expect(isDisplayTypeRequiringStrongEvidence("digital_lcd")).toBe(false);
  });
});
