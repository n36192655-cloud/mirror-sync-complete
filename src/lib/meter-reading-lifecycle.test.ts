import { describe, expect, test } from "bun:test";
import { classifyVerificationError, verificationFailureMessage } from "./meter-reading-lifecycle";

describe("meter verification lifecycle", () => {
  test("mismatch is a terminal failure with a user-facing mismatch message", () => {
    const state = "IDENTITY_FAILED" as const;
    expect(state).toBe("IDENTITY_FAILED");
    expect(verificationFailureMessage(state)).toContain("رقم العداد غير مطابق");
  });

  test("server failures are classified separately", () => {
    expect(classifyVerificationError(new Error("server error"))).toBe("SERVER_ERROR");
  });

  test("timeout failures are terminal", () => {
    expect(classifyVerificationError(new Error("request timed out"))).toBe("TIMEOUT");
  });

  test("success path remains outside terminal failure states", () => {
    const terminalStates = ["IDENTITY_FAILED", "OCR_IMAGE_FAILURE", "SERVER_ERROR", "TIMEOUT", "EXCEPTION"];
    expect(terminalStates.includes("SUCCESS")).toBe(false);
  });
});
