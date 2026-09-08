export type MeterReadingAttemptFailure = "IDENTITY_FAILED" | "OCR_IMAGE_FAILURE" | "SERVER_ERROR" | "TIMEOUT" | "EXCEPTION";

export interface MeterReadingAttemptState {
  attemptCount: number;
  failureReasons: MeterReadingAttemptFailure[];
  updatedAt: string;
}

function key(scope: string) { return `mizan:meter-reading-attempts:${scope}`; }

export function loadMeterReadingAttempts(scope: string): MeterReadingAttemptState {
  if (typeof window === "undefined") return { attemptCount: 0, failureReasons: [], updatedAt: new Date(0).toISOString() };
  try {
    const raw = window.sessionStorage.getItem(key(scope));
    if (!raw) return { attemptCount: 0, failureReasons: [], updatedAt: new Date(0).toISOString() };
    const parsed = JSON.parse(raw) as Partial<MeterReadingAttemptState>;
    const attemptCount = Number.isInteger(parsed.attemptCount) ? Math.max(0, parsed.attemptCount!) : 0;
    const failureReasons = Array.isArray(parsed.failureReasons)
      ? parsed.failureReasons.filter((x): x is MeterReadingAttemptFailure => typeof x === "string").slice(-20)
      : [];
    return { attemptCount, failureReasons, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString() };
  } catch {
    return { attemptCount: 0, failureReasons: [], updatedAt: new Date().toISOString() };
  }
}

function save(scope: string, state: MeterReadingAttemptState) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(key(scope), JSON.stringify(state));
}

export function registerMeterReadingAttempt(scope: string): MeterReadingAttemptState {
  const previous = loadMeterReadingAttempts(scope);
  const next = { ...previous, attemptCount: previous.attemptCount + 1, updatedAt: new Date().toISOString() };
  save(scope, next);
  return next;
}

export function registerMeterReadingFailure(scope: string, reason: MeterReadingAttemptFailure): MeterReadingAttemptState {
  const previous = loadMeterReadingAttempts(scope);
  const next = {
    attemptCount: previous.attemptCount,
    failureReasons: [...previous.failureReasons, reason].slice(-20),
    updatedAt: new Date().toISOString(),
  };
  save(scope, next);
  return next;
}

export function resetMeterReadingAttempts(scope: string) {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(key(scope));
}

/**
 * Retained for backward compatibility with callers that may still import it.
 * Manual entry is not a business fallback gate; it is always permitted after
 * the normal validation path. Attempt history is diagnostic/analytic only.
 */
export function manualFallbackAvailable(_state: MeterReadingAttemptState) {
  return true;
}
