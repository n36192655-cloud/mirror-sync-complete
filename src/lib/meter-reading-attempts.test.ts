import { describe, expect, test } from "bun:test";
import { manualFallbackAvailable } from "./meter-reading-attempts";

describe("meter reading attempts", () => {
  test("manual entry is never gated by attempt count", () => {
    expect(manualFallbackAvailable({ attemptCount: 0, failureReasons: [], updatedAt: "" })).toBe(true);
    expect(manualFallbackAvailable({ attemptCount: 1, failureReasons: ["OCR_IMAGE_FAILURE"], updatedAt: "" })).toBe(true);
    expect(manualFallbackAvailable({ attemptCount: 3, failureReasons: ["OCR_IMAGE_FAILURE", "TIMEOUT", "EXCEPTION"], updatedAt: "" })).toBe(true);
    expect(manualFallbackAvailable({ attemptCount: 10, failureReasons: ["IDENTITY_FAILED"], updatedAt: "" })).toBe(true);
  });
});
