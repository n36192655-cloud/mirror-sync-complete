import type { MeterDisplayType } from "./meter-display";
import { normalizeMeterDigits, parseMeterReading } from "./meter-display";

export interface DisplayReadingEvidence {
  displayType: MeterDisplayType;
  candidate: string;
  confidence: number;
  ambiguous: boolean;
  reason: "clear_numeric_display" | "strong_evidence_required" | "invalid";
}

/** Conservative post-OCR gate shared by local and remote recognition paths. */
export function validateDisplayReading(
  displayType: MeterDisplayType,
  candidate: unknown,
  confidence: number,
): DisplayReadingEvidence {
  const normalized = normalizeMeterDigits(String(candidate ?? "")).trim();
  const parsed = parseMeterReading(normalized);
  if (!parsed.valid || parsed.value === null) {
    return { displayType, candidate: normalized, confidence, ambiguous: true, reason: "invalid" };
  }

  const strong = displayType === "analog_dial" || displayType === "multi_register" || displayType === "smart_display";
  if (strong && confidence < 92) {
    return { displayType, candidate: parsed.normalized, confidence, ambiguous: true, reason: "strong_evidence_required" };
  }

  return {
    displayType,
    candidate: parsed.normalized,
    confidence,
    ambiguous: false,
    reason: "clear_numeric_display",
  };
}
