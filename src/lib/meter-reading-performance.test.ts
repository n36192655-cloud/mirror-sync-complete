import { describe, expect, test } from "bun:test";
import { MeterReadingTimeoutError } from "./meter-reading-deadline";
import { createMeterReadingPerformance, markCaptureCompleted, markFieldAssigned, markProcessingStarted } from "./meter-reading-performance";

describe("meter reading performance trace", () => {
  test("records capture, processing and field-assignment timestamps", () => {
    const trace = createMeterReadingPerformance(1000);
    markCaptureCompleted(trace, 1120);
    markProcessingStarted(trace, 1130);
    markFieldAssigned(trace, 2800);

    expect(trace.captureCompletedAt).toBe(1120);
    expect(trace.processingStartedAt).toBe(1130);
    expect(trace.fieldAssignedAt).toBe(2800);
    expect(trace.totalMs).toBe(1800);
  });

  test("hard-fails a field assignment beyond the five-second SLA", () => {
    const trace = createMeterReadingPerformance(1000);
    markCaptureCompleted(trace, 1100);
    markProcessingStarted(trace, 1200);
    expect(() => markFieldAssigned(trace, 6001)).toThrow(MeterReadingTimeoutError);
  });

  test("rejects field assignment before capture or processing", () => {
    const trace = createMeterReadingPerformance(1000);
    expect(() => markFieldAssigned(trace, 1200)).toThrow(RangeError);

    markCaptureCompleted(trace, 1100);
    expect(() => markFieldAssigned(trace, 1200)).toThrow(RangeError);
  });

  test("rejects non-monotonic stage timestamps", () => {
    const trace = createMeterReadingPerformance(1000);
    expect(() => markCaptureCompleted(trace, 999)).toThrow(RangeError);
    markCaptureCompleted(trace, 1100);
    expect(() => markProcessingStarted(trace, 1099)).toThrow(RangeError);
    markProcessingStarted(trace, 1200);
    expect(() => markFieldAssigned(trace, 1199)).toThrow(RangeError);
  });

  test("rejects non-finite timestamps", () => {
    expect(() => createMeterReadingPerformance(Number.NaN)).toThrow(RangeError);

    const trace = createMeterReadingPerformance(1000);
    expect(() => markCaptureCompleted(trace, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => markCaptureCompleted(trace, Number.NaN)).toThrow(RangeError);
  });
});
