type EntityKind = "customer" | "meter" | "reading" | "bill" | "payment" | "productionLog";

export function mappedUuid(kind: EntityKind, numericId: number): string {
  if (typeof window === "undefined") throw new Error("لا يمكن الوصول إلى معرف السجل خارج المتصفح");
  const raw = window.localStorage.getItem("mizan-id-map");
  if (!raw) throw new Error("تعذّر تحديد السجل في قاعدة البيانات — أعد تحميل الصفحة");
  let parsed: Partial<Record<EntityKind, Array<[number, string]>>>;
  try {
    parsed = JSON.parse(raw) as Partial<Record<EntityKind, Array<[number, string]>>>;
  } catch {
    throw new Error("تعذّر قراءة خريطة السجلات — أعد تحميل الصفحة");
  }
  const uuid = parsed[kind]?.find(([id]) => id === numericId)?.[1];
  if (!uuid) throw new Error("تعذّر تحديد السجل في قاعدة البيانات — أعد تحميل الصفحة");
  return uuid;
}
