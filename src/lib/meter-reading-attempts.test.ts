import { describe, expect, test } from "bun:test";
import { loadMeterReadingAttempts, manualFallbackAvailable, registerMeterReadingAttempt, registerMeterReadingFailure } from "./meter-reading-attempts";

describe("meter reading attempts", () => {
  test("manual entry is never gated by attempt count", () => {
    expect(manualFallbackAvailable({ attemptCount: 0, failureReasons: [], updatedAt: "" })).toBe(true);
    expect(manualFallbackAvailable({ attemptCount: 1, failureReasons: ["OCR_IMAGE_FAILURE"], updatedAt: "" })).toBe(true);
    expect(manualFallbackAvailable({ attemptCount: 3, failureReasons: ["OCR_IMAGE_FAILURE", "TIMEOUT", "EXCEPTION"], updatedAt: "" })).toBe(true);
  });

  test("attempt history can exceed three for diagnostics", () => {
    const scope = `test-${Date.now()}`;
    const first = registerMeterReadingAttempt(scope);
    const second = registerMeterReadingAttempt(scope);
    const third = registerMeterReadingAttempt(scope);
    const fourth = registerMeterReadingAttempt(scope);
    expect([first.attemptCount, second.attemptCount, third.attemptCount, fourth.attemptCount]).toEqual([1, 2, 3, 4]);
    expect(loadMeterReadingAttempts(scope).attemptCount).toBe(4);
  });

  test("failure history remains diagnostic and records identity failures too", () => {
    const scope = `test-fail-${Date.now()}`;
    registerMeterReadingAttempt(scope);
    const state = registerMeterReadingFailure(scope, "IDENTITY_FAILED");
    expect(state.failureReasons).toEqual(["IDENTITY_FAILED"]);
    expect(manualFallbackAvailable(state)).toBe(true);
  });
});
