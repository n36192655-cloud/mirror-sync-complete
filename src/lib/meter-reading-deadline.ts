/** Hard client-side deadline for capture -> validated reading -> current field. */
export const METER_READING_MAX_MS = 5000;

export class MeterReadingTimeoutError extends Error {
  constructor() {
    super("تعذر إكمال قراءة العداد خلال 5 ثوانٍ.");
    this.name = "MeterReadingTimeoutError";
  }
}

export function createMeterReadingDeadline(startedAt = performance.now(), maxMs = METER_READING_MAX_MS) {
  return {
    startedAt,
    remainingMs: () => Math.max(0, maxMs - (performance.now() - startedAt)),
    elapsedMs: () => Math.max(0, performance.now() - startedAt),
    assertWithinDeadline: () => {
      if (performance.now() - startedAt >= maxMs) throw new MeterReadingTimeoutError();
    },
  };
}

export async function withMeterReadingDeadline<T>(
  task: Promise<T>,
  deadline = createMeterReadingDeadline(),
): Promise<T> {
  const remaining = deadline.remainingMs();
  if (remaining <= 0) throw new MeterReadingTimeoutError();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new MeterReadingTimeoutError()), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
