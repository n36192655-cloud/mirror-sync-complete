import type { MeterDisplayType } from "./meter-display";
import { isDisplayTypeRequiringStrongEvidence, parseMeterReading } from "./meter-display";

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
  const parsed = parseMeterReading(candidate);
  if (!parsed.valid || parsed.value === null) {
    return { displayType, candidate: parsed.normalized, confidence, ambiguous: true, reason: "invalid" };
  }

  if (isDisplayTypeRequiringStrongEvidence(displayType) && confidence < 92) {
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
