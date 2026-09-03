export type MeterDisplayType =
  | "mechanical_roller"
  | "digital_lcd"
  | "digital_led"
  | "black_red_register"
  | "multi_register"
  | "analog_dial"
  | "smart_display"
  | "unknown";

const DISPLAY_TYPES = new Set<MeterDisplayType>([
  "mechanical_roller",
  "digital_lcd",
  "digital_led",
  "black_red_register",
  "multi_register",
  "analog_dial",
  "smart_display",
  "unknown",
]);

export function normalizeMeterDisplayType(value: unknown): MeterDisplayType {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return DISPLAY_TYPES.has(normalized as MeterDisplayType) ? normalized as MeterDisplayType : "unknown";
}

/** Normalize decimal digits used by Arabic/Persian and common Indic scripts. */
export function normalizeMeterDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹०-९০-৯૦-૯੦-੯௦-௯౦-౯೦-೯൦-൯୦-୯]/g, (digit) => {
    const code = digit.charCodeAt(0);
    const ranges: Array<[number, number]> = [
      [0x0660, 0x0669], // Arabic-Indic
      [0x06f0, 0x06f9], // Eastern Arabic-Indic / Persian
      [0x0966, 0x096f], // Devanagari
      [0x09e6, 0x09ef], // Bengali
      [0x0ae6, 0x0aef], // Gujarati
      [0x0a66, 0x0a6f], // Gurmukhi
      [0x0be6, 0x0bef], // Tamil
      [0x0c66, 0x0c6f], // Telugu
      [0x0ce6, 0x0cef], // Kannada
      [0x0d66, 0x0d6f], // Malayalam
      [0x0b66, 0x0b6f], // Odia
    ];
    for (const [start, end] of ranges) {
      if (code >= start && code <= end) return String(code - start);
    }
    return digit;
  });
}

export interface MeterReadingParse {
  value: number | null;
  normalized: string;
  valid: boolean;
}

export function parseMeterReading(value: unknown): MeterReadingParse {
  if (typeof value !== "string" && typeof value !== "number") return { value: null, normalized: "", valid: false };
  const normalized = normalizeMeterDigits(String(value))
    .trim()
    .replace(/\s/g, "")
    .replace(/[٫﹒．]/g, ".")
    .replace(/,/g, ".");
  if (!/^(?:\d{1,12}|\d{1,12}\.\d{1,3})$/.test(normalized)) return { value: null, normalized, valid: false };
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return { value: null, normalized, valid: false };
  return { value: parsed, normalized, valid: true };
}

export function isDisplayTypeRequiringStrongEvidence(type: MeterDisplayType): boolean {
  return type === "analog_dial" || type === "multi_register" || type === "smart_display" || type === "black_red_register";
}
