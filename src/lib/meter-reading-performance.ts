import { METER_READING_MAX_MS, MeterReadingTimeoutError } from "./meter-reading-deadline";

export interface MeterReadingPerformance {
  startedAt: number;
  captureCompletedAt: number | null;
  processingStartedAt: number | null;
  fieldAssignedAt: number | null;
  totalMs: number | null;
}

export function createMeterReadingPerformance(startedAt = performance.now()): MeterReadingPerformance {
  return {
    startedAt,
    captureCompletedAt: null,
    processingStartedAt: null,
    fieldAssignedAt: null,
    totalMs: null,
  };
}

export function markCaptureCompleted(trace: MeterReadingPerformance, at = performance.now()): void {
  trace.captureCompletedAt = at;
}

export function markProcessingStarted(trace: MeterReadingPerformance, at = performance.now()): void {
  trace.processingStartedAt = at;
}

export function markFieldAssigned(trace: MeterReadingPerformance, at = performance.now()): void {
  trace.fieldAssignedAt = at;
  trace.totalMs = Math.max(0, at - trace.startedAt);
  if (trace.totalMs > METER_READING_MAX_MS) {
    throw new MeterReadingTimeoutError();
  }
}

export function getMeterReadingElapsedMs(trace: MeterReadingPerformance, at = performance.now()): number {
  return Math.max(0, at - trace.startedAt);
}
