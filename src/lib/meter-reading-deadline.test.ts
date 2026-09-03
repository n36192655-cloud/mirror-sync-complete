import { describe, expect, test } from "bun:test";
import { createMeterReadingDeadline, MeterReadingTimeoutError, withMeterReadingDeadline } from "./meter-reading-deadline";

describe("meter reading deadline", () => {
  test("expires an operation that exceeds the configured budget", async () => {
    const deadline = createMeterReadingDeadline(performance.now(), 10);
    await expect(withMeterReadingDeadline(new Promise<string>((resolve) => setTimeout(() => resolve("late"), 30)), deadline)).rejects.toBeInstanceOf(MeterReadingTimeoutError);
  });

  test("accepts a completed operation inside the budget", async () => {
    const deadline = createMeterReadingDeadline(performance.now(), 100);
    await expect(withMeterReadingDeadline(Promise.resolve("ok"), deadline)).resolves.toBe("ok");
  });
});
