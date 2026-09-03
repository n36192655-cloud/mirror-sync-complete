import { describe, expect, test } from "bun:test";
import { validateDisplayReading } from "./meter-display-decision";

describe("meter display decision", () => {
  test("accepts clear roller and LCD readings", () => {
    expect(validateDisplayReading("mechanical_roller", "001234", 90).ambiguous).toBe(false);
    expect(validateDisplayReading("digital_lcd", "1234.5", 90).ambiguous).toBe(false);
  });

  test("requires stronger evidence for analog and multi-register displays", () => {
    expect(validateDisplayReading("analog_dial", "1234", 91).ambiguous).toBe(true);
    expect(validateDisplayReading("multi_register", "1234", 91).ambiguous).toBe(true);
    expect(validateDisplayReading("smart_display", "1234", 92).ambiguous).toBe(false);
    expect(validateDisplayReading("black_red_register", "1234", 91).ambiguous).toBe(true);
  });

  test("rejects malformed readings", () => {
    expect(validateDisplayReading("digital_led", "DN50", 99).ambiguous).toBe(true);
    expect(validateDisplayReading("digital_led", "12.3456", 99).ambiguous).toBe(true);
  });

  test("normalizes Arabic-Indic digits and decimal punctuation", () => {
    const result = validateDisplayReading("digital_lcd", "١٢٣٤٫٥", 95);
    expect(result.candidate).toBe("1234.5");
    expect(result.ambiguous).toBe(false);
  });
});
