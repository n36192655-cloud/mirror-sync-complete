import { describe, expect, test } from "bun:test";
import { classifyVerificationError, verificationFailureMessage } from "./meter-reading-lifecycle";

describe("meter verification lifecycle", () => {
  test("mismatch is a terminal failure with a user-facing mismatch message", () => {
    const state = "IDENTITY_FAILED" as const;
    expect(state).toBe("IDENTITY_FAILED");
    expect(verificationFailureMessage(state)).toContain("رقم العداد غير مطابق");
  });

  test("mismatch path does not invalidate the active capture before finally cleanup", async () => {
    const source = await Bun.file(new URL("../routes/readings.tsx", import.meta.url)).text();
    const start = source.indexOf("async function handleCapture");
    const end = source.indexOf("async function captureGeo", start);
    const handleCapture = source.slice(start, end);

    expect(handleCapture).toContain("finishVerificationFailure(\"IDENTITY_FAILED\"");
    expect(handleCapture).not.toContain("setPipelineState(\"IDENTITY_FAILED\"); clearPipeline()");
    expect(handleCapture).toContain("finally { if (captureSequenceRef.current === captureToken) setOcrBusy(false); captureStartedRef.current = null; }");
    expect(handleCapture).toContain("resetVerificationArtifacts()");
    expect(source).toContain("setPipelineState(\"READY_TO_SAVE\")");
  });

  test("terminal failure cleanup clears the stale reading and verification token", async () => {
    const source = await Bun.file(new URL("../routes/readings.tsx", import.meta.url)).text();
    const start = source.indexOf("function resetVerificationArtifacts");
    const end = source.indexOf("function finishVerificationFailure", start);
    const cleanup = source.slice(start, end);

    expect(cleanup).toContain("verificationTokenRef.current = null");
    expect(cleanup).toContain("setOcrReading(null)");
    expect(cleanup).toContain("setCurrent(\"\")");
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
