export type VerificationTerminalState = "IDENTITY_FAILED" | "OCR_IMAGE_FAILURE" | "SERVER_ERROR" | "TIMEOUT" | "EXCEPTION";

export function classifyVerificationError(error: unknown): VerificationTerminalState {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") return "TIMEOUT";
  if (/timeout|timed out|deadline|aborted/i.test(message)) return "TIMEOUT";
  if (/server|network|fetch|gateway|internal|rpc|status\s*5\d\d|\b5\d\d\b/i.test(message)) return "SERVER_ERROR";
  return "EXCEPTION";
}

export function verificationFailureMessage(state: VerificationTerminalState): string {
  switch (state) {
    case "SERVER_ERROR":
      return "تعذر إكمال التحقق من الخادم. أعد التصوير والمحاولة مرة أخرى.";
    case "TIMEOUT":
      return "انتهى وقت التحقق. أعد تصوير العداد وحاول مرة أخرى.";
    case "OCR_IMAGE_FAILURE":
      return "تعذر استخراج قراءة واضحة من الصورة. أعد التصوير مع تقريب شاشة العداد.";
    case "IDENTITY_FAILED":
      return "رقم العداد غير مطابق للعداد المرتبط. أعد تصوير العداد الصحيح.";
    case "EXCEPTION":
      return "تعذر تحليل صورة العداد. أعد التصوير والمحاولة مرة أخرى.";
  }
}
