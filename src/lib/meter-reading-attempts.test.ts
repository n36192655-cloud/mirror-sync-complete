import { describe, expect, test } from "bun:test";
import { manualFallbackAvailable } from "./meter-reading-attempts";

describe("meter reading attempts", () => {
  test("manual entry is never gated by attempt count", () => {
    for (let attemptCount = 0; attemptCount <= 10; attemptCount += 1) {
      expect(manualFallbackAvailable({ attemptCount, failureReasons: [], updatedAt: "" })).toBe(true);
    }
  });

  test("diagnostic attempt counts remain usable above three", () => {
    for (const attemptCount of [4, 5, 6, 7, 8, 9, 10]) {
      expect(manualFallbackAvailable({ attemptCount, failureReasons: ["OCR_IMAGE_FAILURE"], updatedAt: "" })).toBe(true);
    }
  });
});
