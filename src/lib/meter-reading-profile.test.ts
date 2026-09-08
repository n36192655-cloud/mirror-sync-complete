import { describe, expect, test } from "bun:test";
import { EMPTY_METER_READING_PROFILE, normalizeMeterReadingCandidate, type MeterReadingProfile } from "./meter-reading-profile";

const fourDecimal: MeterReadingProfile = {
  displayType: "digital_lcd",
  integerDigits: 6,
  decimalDigits: 4,
  decimalSeparator: ".",
  registerSemantics: null,
};

describe("authoritative meter reading precision", () => {
  test("preserves a four-decimal reading when the profile allows it", () => {
    const result = normalizeMeterReadingCandidate("179.3836", fourDecimal);
    expect(result?.normalized).toBe("179.3836");
    expect(result?.value).toBe(179.3836);
  });

  test("does not silently assign decimal semantics when the profile is missing", () => {
    expect(normalizeMeterReadingCandidate("179.3836", EMPTY_METER_READING_PROFILE)).toBeNull();
  });

  test("accepts whole-number readings without a decimal profile", () => {
    const result = normalizeMeterReadingCandidate("179", EMPTY_METER_READING_PROFILE);
    expect(result?.value).toBe(179);
  });

  test("does not exceed the configured decimal precision", () => {
    expect(normalizeMeterReadingCandidate("179.38365", fourDecimal)).toBeNull();
  });

  test("respects an authoritative comma decimal separator", () => {
    const result = normalizeMeterReadingCandidate("179,3836", { ...fourDecimal, decimalSeparator: "," });
    expect(result?.value).toBe(179.3836);
    expect(normalizeMeterReadingCandidate("179.3836", { ...fourDecimal, decimalSeparator: "," })).toBeNull();
  });
});
