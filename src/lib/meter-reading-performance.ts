import { METER_READING_MAX_MS, MeterReadingTimeoutError } from "./meter-reading-deadline";

export interface MeterReadingPerformance {
  startedAt: number;
  captureCompletedAt: number | null;
  processingStartedAt: number | null;
  fieldAssignedAt: number | null;
  totalMs: number | null;
}

export function createMeterReadingPerformance(startedAt = performance.now()): MeterReadingPerformance {
  if (!Number.isFinite(startedAt)) throw new TypeError("startedAt must be finite");
  return { startedAt, captureCompletedAt: null, processingStartedAt: null, fieldAssignedAt: null, totalMs: null };
}

function assertTimestamp(at: number): void {
  if (!Number.isFinite(at)) throw new TypeError("timestamp must be finite");
}

export function markCaptureCompleted(trace: MeterReadingPerformance, at = performance.now()): void {
  assertTimestamp(at);
  if (at < trace.startedAt) throw new RangeError("capture completion cannot precede trace start");
  trace.captureCompletedAt = at;
}

export function markProcessingStarted(trace: MeterReadingPerformance, at = performance.now()): void {
  assertTimestamp(at);
  if (at < trace.startedAt) throw new RangeError("processing cannot precede trace start");
  if (trace.captureCompletedAt !== null && at < trace.captureCompletedAt) throw new RangeError("processing cannot precede capture completion");
  trace.processingStartedAt = at;
}

export function markFieldAssigned(trace: MeterReadingPerformance, at = performance.now()): void {
  assertTimestamp(at);
  if (at < trace.startedAt) throw new RangeError("field assignment cannot precede trace start");
  if (trace.captureCompletedAt === null || trace.processingStartedAt === null) throw new Error("field assignment requires capture and processing timestamps");
  if (at < trace.captureCompletedAt || at < trace.processingStartedAt) throw new RangeError("field assignment cannot precede prior stages");
  trace.fieldAssignedAt = at;
  trace.totalMs = at - trace.startedAt;
  if (trace.totalMs > METER_READING_MAX_MS) throw new MeterReadingTimeoutError();
}

export function getMeterReadingElapsedMs(trace: MeterReadingPerformance, at = performance.now()): number {
  assertTimestamp(at);
  return Math.max(0, at - trace.startedAt);
}
