import { describe, expect, test } from "bun:test";
import { manualFallbackAvailable } from "./meter-reading-attempts";

describe("three-attempt manual fallback policy", () => {
  test("does not expose manual fallback before three failed attempts", () => {
    expect(manualFallbackAvailable({ attemptCount: 1, failureReasons: ["OCR_IMAGE_FAILURE"], updatedAt: "" })).toBe(false);
    expect(manualFallbackAvailable({ attemptCount: 2, failureReasons: ["OCR_IMAGE_FAILURE", "TIMEOUT"], updatedAt: "" })).toBe(false);
  });

  test("exposes manual fallback only after exactly three documented failures", () => {
    expect(manualFallbackAvailable({ attemptCount: 3, failureReasons: ["OCR_IMAGE_FAILURE", "TIMEOUT", "IDENTITY_FAILED"], updatedAt: "" })).toBe(true);
  });

  test("three attempts without three failure records is not enough", () => {
    expect(manualFallbackAvailable({ attemptCount: 3, failureReasons: ["OCR_IMAGE_FAILURE", "TIMEOUT"], updatedAt: "" })).toBe(false);
  });
});
