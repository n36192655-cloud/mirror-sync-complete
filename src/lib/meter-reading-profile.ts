export type MeterDisplayType =
  | "mechanical_roller"
  | "black_red_register"
  | "white_red_register"
  | "multi_register"
  | "analog_dial"
  | "digital_lcd"
  | "digital_led"
  | "smart_display"
  | "unknown";

export interface MeterReadingProfile {
  displayType: MeterDisplayType | null;
  integerDigits: number | null;
  decimalDigits: number | null;
  decimalSeparator: "." | "," | null;
  registerSemantics: Record<string, unknown> | null;
}

export const EMPTY_METER_READING_PROFILE: MeterReadingProfile = {
  displayType: null,
  integerDigits: null,
  decimalDigits: null,
  decimalSeparator: null,
  registerSemantics: null,
};

function normalizeDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return code >= 0x0660 && code <= 0x0669
      ? String(code - 0x0660)
      : String(code - 0x06f0);
  });
}

/**
 * Parse only when the meter profile makes decimal semantics authoritative.
 * A missing decimal_digits value never causes OCR to invent a decimal meaning.
 */
export function normalizeMeterReadingCandidate(
  raw: string,
  profile: MeterReadingProfile = EMPTY_METER_READING_PROFILE,
): { normalized: string; value: number } | null {
  const source = normalizeDigits(raw).replace(/\s/g, "");
  if (!source) return null;

  const configuredSeparator = profile.decimalSeparator;
  let normalized = source;

  if (configuredSeparator === ",") {
    if (normalized.includes(".")) return null;
    normalized = normalized.replace(/,/g, ".");
  } else if (configuredSeparator === ".") {
    if (normalized.includes(",")) return null;
  } else {
    const hasDot = normalized.includes(".");
    const hasComma = normalized.includes(",");
    if (hasDot && hasComma) return null;
    if (hasComma) normalized = normalized.replace(/,/g, ".");
  }

  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const [integerPart, decimalPart = ""] = normalized.split(".");
  if (profile.integerDigits != null && integerPart.length > profile.integerDigits) return null;

  if (decimalPart.length > 0) {
    if (profile.decimalDigits == null) return null;
    if (profile.decimalDigits === 0 || decimalPart.length > profile.decimalDigits) return null;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return { normalized, value };
}

export function formatMeterReadingForInput(value: number, profile: MeterReadingProfile = EMPTY_METER_READING_PROFILE): string {
  if (!Number.isFinite(value)) return "";
  const raw = String(value);
  if (profile.decimalDigits == null) return raw;
  return raw.includes(".") ? raw : `${raw}.${"0".repeat(profile.decimalDigits)}`;
}
