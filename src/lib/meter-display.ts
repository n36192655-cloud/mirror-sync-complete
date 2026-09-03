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

export function normalizeMeterDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return code >= 0x0660 && code <= 0x0669
      ? String(code - 0x0660)
      : String(code - 0x06f0);
  });
}

export interface MeterReadingParse {
  value: number | null;
  normalized: string;
  valid: boolean;
}

export function parseMeterReading(value: unknown): MeterReadingParse {
  if (typeof value !== "string" && typeof value !== "number") return { value: null, normalized: "", valid: false };
  const normalized = normalizeMeterDigits(String(value)).trim().replace(/\s/g, "").replace(/,/g, ".");
  if (!/^(?:\d{1,12}|\d{1,12}\.\d{1,3})$/.test(normalized)) return { value: null, normalized, valid: false };
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return { value: null, normalized, valid: false };
  return { value: parsed, normalized, valid: true };
}

export function isDisplayTypeRequiringStrongEvidence(type: MeterDisplayType): boolean {
  return type === "analog_dial" || type === "multi_register" || type === "smart_display";
}
